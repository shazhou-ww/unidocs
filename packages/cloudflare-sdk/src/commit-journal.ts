import { computeCommitRequestDigest, type CommitPayload, type SessionIdentity } from "@unidocs/doctype-server-common";
import { parseCommitReceipt, parseCommitRequestIdentity, type CommitReceipt, type CommitRequestIdentity } from "@unidocs/protocol-doc";
import { decodeSValue, encodeSValue } from "@unidocs/svalue-codec";

export interface CommitJournalStorage {
  sql: { exec(query: string, ...bindings: (string | number | ArrayBuffer)[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<Result>(callback: () => Result): Result;
}

export type TerminalCommitReceipt = Extract<CommitReceipt, { state: "committed" | "rejected" }>;
export const MAX_COMMIT_PAYLOAD_BYTES = 1_048_576;

export class CommitJournalConflict extends Error {
  constructor(readonly code: "payload_mismatch" | "pending_exists" | "terminal_mismatch" | "not_found") {
    super(code);
  }
}

export class SqliteCommitJournal {
  readonly #scope: string;
  readonly #identity: SessionIdentity;

  constructor(private readonly storage: CommitJournalStorage, identity: SessionIdentity, initialize = true) {
    if (![identity.tenantId, identity.docType, identity.sessionId].every(value => typeof value === "string" && value.length > 0)) {
      throw new Error("Invalid commit journal scope");
    }
    this.#identity = { tenantId: identity.tenantId, docType: identity.docType, sessionId: identity.sessionId };
    this.#scope = JSON.stringify([identity.tenantId, identity.docType, identity.sessionId]);
    if (!initialize) return;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS doc_commit_intents_v1 (
      scope TEXT NOT NULL, op_id TEXT NOT NULL, request_digest TEXT NOT NULL,
      base_version INTEGER NOT NULL, payload BLOB NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'committed', 'rejected')),
      receipt TEXT NOT NULL, PRIMARY KEY(scope, op_id)
    )`);
    storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS doc_commit_one_pending_v1
      ON doc_commit_intents_v1(scope) WHERE state = 'pending'`);
  }

  async begin(opId: string, payload: CommitPayload): Promise<CommitReceipt> {
    parseCommitRequestIdentity({ opId, baseVersion: payload.baseVersion, requestDigest: "0".repeat(64) });
    const bytes = encodeSValue({ baseVersion: payload.baseVersion, description: payload.description, operations: [...payload.operations] });
    if (bytes.byteLength > MAX_COMMIT_PAYLOAD_BYTES) throw new Error("Commit payload exceeds journal limit");
    const candidate = decodeSValue(bytes) as unknown as CommitPayload;
    const requestDigest = await computeCommitRequestDigest(this.#identity, candidate);
    const identity = { opId, baseVersion: candidate.baseVersion, requestDigest };
    return this.storage.transactionSync(() => {
      const existing = this.#read(opId);
      if (existing) { this.#match(existing, identity); return existing; }
      if (this.storage.sql.exec("SELECT op_id FROM doc_commit_intents_v1 WHERE scope = ? AND state = 'pending'", this.#scope).toArray().length) {
        throw new CommitJournalConflict("pending_exists");
      }
      const receipt: CommitReceipt = { ...identity, state: "pending" };
      this.storage.sql.exec(`INSERT INTO doc_commit_intents_v1
        (scope, op_id, request_digest, base_version, payload, state, receipt) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      this.#scope, opId, requestDigest, candidate.baseVersion, Uint8Array.from(bytes).buffer, JSON.stringify(receipt));
      return receipt;
    });
  }

  lookup(request: CommitRequestIdentity): CommitReceipt {
    const identity = parseCommitRequestIdentity(request);
    const receipt = this.#read(identity.opId);
    if (!receipt) return { ...identity, state: "unknown", reason: "not_found" };
    this.#match(receipt, identity);
    return receipt;
  }

  pendingIdentity(): CommitReceipt | null {
    const row = this.storage.sql.exec("SELECT op_id, request_digest, base_version, state, receipt FROM doc_commit_intents_v1 WHERE scope = ? AND state = 'pending'", this.#scope).toArray()[0];
    return row ? this.#receipt(row) : null;
  }

  async recoverPending(): Promise<{ receipt: CommitReceipt; payload: CommitPayload } | null> {
    const row = this.storage.sql.exec("SELECT * FROM doc_commit_intents_v1 WHERE scope = ? AND state = 'pending'", this.#scope).toArray()[0];
    if (!row) return null;
    const receipt = this.#receipt(row);
    const bytes = row.payload;
    if (!(bytes instanceof ArrayBuffer) && !(bytes instanceof Uint8Array)) throw new Error("Invalid stored commit payload");
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.byteLength > MAX_COMMIT_PAYLOAD_BYTES) throw new Error("Stored commit payload exceeds journal limit");
    const payload = decodeSValue(data) as unknown as CommitPayload;
    if (payload.baseVersion !== receipt.baseVersion
      || await computeCommitRequestDigest(this.#identity, payload) !== receipt.requestDigest) throw new Error("Stored commit digest mismatch");
    return { receipt, payload };
  }

  settle(result: TerminalCommitReceipt, finalizeLocal: () => undefined): CommitReceipt {
    const receipt = parseCommitReceipt(result);
    if (receipt.state !== "committed" && receipt.state !== "rejected") throw new Error("Commit result is not terminal");
    return this.storage.transactionSync(() => {
      const existing = this.#read(receipt.opId);
      if (!existing) throw new CommitJournalConflict("not_found");
      this.#match(existing, receipt);
      if (existing.state !== "pending") {
        if (JSON.stringify(existing) !== JSON.stringify(receipt)) throw new CommitJournalConflict("terminal_mismatch");
        return existing;
      }
      const returned: unknown = finalizeLocal();
      if (returned !== null && (typeof returned === "object" || typeof returned === "function") && "then" in returned) {
        throw new Error("Commit finalization must be synchronous");
      }
      this.storage.sql.exec("UPDATE doc_commit_intents_v1 SET state = ?, receipt = ? WHERE scope = ? AND op_id = ?",
        receipt.state, JSON.stringify(receipt), this.#scope, receipt.opId);
      return receipt;
    });
  }

  #read(opId: string): CommitReceipt | null {
    if (!this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'doc_commit_intents_v1'").toArray().length) return null;
    const row = this.storage.sql.exec("SELECT op_id, request_digest, base_version, state, receipt FROM doc_commit_intents_v1 WHERE scope = ? AND op_id = ?", this.#scope, opId).toArray()[0];
    return row ? this.#receipt(row) : null;
  }

  #receipt(row: Record<string, unknown>): CommitReceipt {
    if (typeof row.receipt !== "string") throw new Error("Invalid stored commit receipt");
    const receipt = parseCommitReceipt(JSON.parse(row.receipt));
    if (receipt.opId !== row.op_id || receipt.requestDigest !== row.request_digest
      || receipt.baseVersion !== row.base_version || receipt.state !== row.state || receipt.state === "unknown") {
      throw new Error("Stored commit identity mismatch");
    }
    return receipt;
  }

  #match(receipt: CommitReceipt, request: CommitRequestIdentity): void {
    if (receipt.requestDigest !== request.requestDigest || receipt.baseVersion !== request.baseVersion) {
      throw new CommitJournalConflict("payload_mismatch");
    }
  }
}