import { DurableObject } from "cloudflare:workers";

export interface PlatformDocumentIdentity {
  readonly tenantId: string;
  readonly docId: string;
  readonly docType: string;
  readonly ownerActorId: string;
  readonly schemaVersion: string;
}

export interface PlatformDocumentVersion {
  readonly version: number;
  readonly stateHash: string;
  readonly createdAt: number;
}

export interface PlatformDocumentCreation {
  readonly identity: PlatformDocumentIdentity;
  readonly stateHash: string;
  readonly requestDigest: string;
}

export interface PlatformCommitCandidate {
  readonly operationId: string;
  readonly baseVersion: number;
  readonly stateHash: string;
}

export type PlatformCommitReceipt = {
  readonly operationId: string;
  readonly baseVersion: number;
  readonly requestDigest: string;
} & (
  | { readonly state: "pending" }
  | { readonly state: "committed"; readonly version: number }
  | { readonly state: "rejected"; readonly reason: "version_conflict"; readonly headVersion: number }
);

export type PlatformCommitStatus = PlatformCommitReceipt
  | { readonly operationId: string; readonly state: "unknown"; readonly reason: "not_found" };

export interface PlatformPendingCommit {
  readonly candidate: PlatformCommitCandidate;
  readonly receipt: Extract<PlatformCommitReceipt, { readonly state: "pending" }>;
}

interface DocumentRow {
  [column: string]: SqlStorageValue;
  tenant_id: string;
  doc_id: string;
  doc_type: string;
  owner_actor_id: string;
  schema_version: string;
  head_version: number;
}

interface IntentRow {
  [column: string]: SqlStorageValue;
  operation_id: string;
  base_version: number;
  request_digest: string;
  state_hash: string;
  receipt: string;
}

export class PlatformDocument extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS platform_document_v1 (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), tenant_id TEXT NOT NULL, doc_id TEXT NOT NULL,
      doc_type TEXT NOT NULL, owner_actor_id TEXT NOT NULL, schema_version TEXT NOT NULL,
      head_version INTEGER NOT NULL CHECK(head_version >= 1)
    ); CREATE TABLE IF NOT EXISTS platform_document_versions_v1 (
      version INTEGER PRIMARY KEY CHECK(version >= 1), state_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS platform_document_creation_v1 (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), identity TEXT NOT NULL,
      state_hash TEXT NOT NULL, request_digest TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS platform_document_intents_v1 (
      operation_id TEXT PRIMARY KEY, base_version INTEGER NOT NULL, request_digest TEXT NOT NULL,
      state_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending', 'committed', 'rejected')),
      receipt TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS platform_document_one_pending_v1
      ON platform_document_intents_v1(state) WHERE state = 'pending'`);
  }

  async beginCreate(identity: PlatformDocumentIdentity, initialStateHash: string): Promise<PlatformDocumentCreation> {
    const normalized = requireIdentity(identity);
    requireHash(initialStateHash);
    const requestDigest = await digestCreation(normalized, initialStateHash);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.#document();
      if (existing) {
        if (!sameIdentity(existing, normalized) || this.#version(1).stateHash !== initialStateHash) {
          throw new Error("document_create_conflict");
        }
        return { identity: normalized, stateHash: initialStateHash, requestDigest };
      }
      const pending = this.ctx.storage.sql.exec<{ identity: string; state_hash: string; request_digest: string }>(
        "SELECT identity, state_hash, request_digest FROM platform_document_creation_v1 WHERE singleton = 1",
      ).toArray()[0];
      if (pending) {
        if (pending.identity !== JSON.stringify(normalized) || pending.state_hash !== initialStateHash
          || pending.request_digest !== requestDigest) throw new Error("document_create_conflict");
      } else {
        this.ctx.storage.sql.exec(`INSERT INTO platform_document_creation_v1
          (singleton, identity, state_hash, request_digest) VALUES (1, ?, ?, ?)`,
        JSON.stringify(normalized), initialStateHash, requestDigest);
      }
      return { identity: normalized, stateHash: initialStateHash, requestDigest };
    });
  }

  createRetained(identity: PlatformDocumentIdentity, initialStateHash: string, createdAt: number): {
    readonly identity: PlatformDocumentIdentity;
    readonly head: PlatformDocumentVersion;
  } {
    const normalized = requireIdentity(identity);
    requireHash(initialStateHash);
    requireTimestamp(createdAt);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.#document();
      if (existing) {
        if (!sameIdentity(existing, normalized)) throw new Error("document_identity_conflict");
        const head = this.#version(existing.head_version);
        if (head.version !== 1 || head.stateHash !== initialStateHash) throw new Error("document_create_conflict");
        return { identity: normalized, head };
      }
      const pending = this.ctx.storage.sql.exec<{ identity: string; state_hash: string }>(
        "SELECT identity, state_hash FROM platform_document_creation_v1 WHERE singleton = 1",
      ).one();
      if (pending.identity !== JSON.stringify(normalized) || pending.state_hash !== initialStateHash) {
        throw new Error("document_create_conflict");
      }
      this.ctx.storage.sql.exec(`INSERT INTO platform_document_v1
        (singleton, tenant_id, doc_id, doc_type, owner_actor_id, schema_version, head_version)
        VALUES (1, ?, ?, ?, ?, ?, 1)`, normalized.tenantId, normalized.docId, normalized.docType,
      normalized.ownerActorId, normalized.schemaVersion);
      this.ctx.storage.sql.exec(`INSERT INTO platform_document_versions_v1
        (version, state_hash, created_at) VALUES (1, ?, ?)`, initialStateHash, createdAt);
      this.ctx.storage.sql.exec("DELETE FROM platform_document_creation_v1 WHERE singleton = 1");
      return { identity: normalized, head: { version: 1, stateHash: initialStateHash, createdAt } };
    });
  }

  read(): { readonly identity: PlatformDocumentIdentity; readonly head: PlatformDocumentVersion } | null {
    const document = this.#document();
    if (!document) return null;
    return { identity: fromDocumentRow(document), head: this.#version(document.head_version) };
  }

  async beginCommit(candidate: PlatformCommitCandidate): Promise<PlatformCommitReceipt> {
    const normalized = requireCandidate(candidate);
    const identity = fromDocumentRow(this.#requireDocument());
    const requestDigest = await digestCandidate(identity, normalized);
    return this.ctx.storage.transactionSync(() => {
      const document = this.#requireDocument();
      const existing = this.#intent(normalized.operationId);
      if (existing) {
        if (existing.request_digest !== requestDigest || existing.base_version !== normalized.baseVersion
          || existing.state_hash !== normalized.stateHash) throw new Error("operation_payload_conflict");
        return parseReceipt(existing.receipt);
      }
      const identity = { operationId: normalized.operationId, baseVersion: normalized.baseVersion, requestDigest };
      const receipt: PlatformCommitReceipt = normalized.baseVersion === document.head_version
        ? { ...identity, state: "pending" }
        : { ...identity, state: "rejected", reason: "version_conflict", headVersion: document.head_version };
      this.ctx.storage.sql.exec(`INSERT INTO platform_document_intents_v1
        (operation_id, base_version, request_digest, state_hash, state, receipt) VALUES (?, ?, ?, ?, ?, ?)`,
      normalized.operationId, normalized.baseVersion, requestDigest, normalized.stateHash, receipt.state, JSON.stringify(receipt));
      return receipt;
    });
  }

  commitRetained(operationId: string, committedAt: number): PlatformCommitReceipt {
    requireOperationId(operationId);
    requireTimestamp(committedAt);
    return this.ctx.storage.transactionSync(() => {
      const document = this.#requireDocument();
      const intent = this.#intent(operationId);
      if (!intent) throw new Error("operation_not_found");
      const receipt = parseReceipt(intent.receipt);
      if (receipt.state !== "pending") return receipt;
      if (document.head_version !== receipt.baseVersion) {
        throw new Error("pending_head_changed");
      }
      const version = receipt.baseVersion + 1;
      const committed: PlatformCommitReceipt = { operationId, baseVersion: receipt.baseVersion,
        requestDigest: receipt.requestDigest, state: "committed", version };
      this.ctx.storage.sql.exec(`INSERT INTO platform_document_versions_v1
        (version, state_hash, created_at) VALUES (?, ?, ?)`, version, intent.state_hash, committedAt);
      this.ctx.storage.sql.exec("UPDATE platform_document_v1 SET head_version = ? WHERE singleton = 1", version);
      this.ctx.storage.sql.exec(`UPDATE platform_document_intents_v1
        SET state = 'committed', receipt = ? WHERE operation_id = ?`, JSON.stringify(committed), operationId);
      return committed;
    });
  }

  commitStatus(operationId: string): PlatformCommitStatus {
    requireOperationId(operationId);
    const intent = this.#intent(operationId);
    if (intent) return parseReceipt(intent.receipt);
    return { operationId, state: "unknown", reason: "not_found" };
  }

  pendingCommit(operationId: string): PlatformPendingCommit | null {
    requireOperationId(operationId);
    const intent = this.#intent(operationId);
    if (!intent) return null;
    const receipt = parseReceipt(intent.receipt);
    if (receipt.state !== "pending") return null;
    return { candidate: { operationId, baseVersion: intent.base_version, stateHash: intent.state_hash }, receipt };
  }

  #document(): DocumentRow | null {
    return this.ctx.storage.sql.exec<DocumentRow>("SELECT * FROM platform_document_v1 WHERE singleton = 1").toArray()[0] ?? null;
  }

  #requireDocument(): DocumentRow {
    const document = this.#document();
    if (!document) throw new Error("document_not_found");
    return document;
  }

  #version(version: number): PlatformDocumentVersion {
    const row = this.ctx.storage.sql.exec<{ version: number; state_hash: string; created_at: number }>(
      "SELECT version, state_hash, created_at FROM platform_document_versions_v1 WHERE version = ?", version,
    ).one();
    return { version: row.version, stateHash: row.state_hash, createdAt: row.created_at };
  }

  #intent(operationId: string): IntentRow | null {
    return this.ctx.storage.sql.exec<IntentRow>(
      "SELECT operation_id, base_version, request_digest, state_hash, receipt FROM platform_document_intents_v1 WHERE operation_id = ?",
      operationId,
    ).toArray()[0] ?? null;
  }
}

function requireIdentity(identity: PlatformDocumentIdentity): PlatformDocumentIdentity {
  const values = [identity.tenantId, identity.docId, identity.docType, identity.ownerActorId, identity.schemaVersion];
  if (!values.every(value => typeof value === "string" && value.length > 0 && value.length <= 256)) {
    throw new TypeError("Invalid platform document identity");
  }
  return { ...identity };
}

function requireCandidate(candidate: PlatformCommitCandidate): PlatformCommitCandidate {
  requireOperationId(candidate.operationId);
  if (!Number.isSafeInteger(candidate.baseVersion) || candidate.baseVersion < 1 || candidate.baseVersion === Number.MAX_SAFE_INTEGER) {
    throw new TypeError("Invalid base version");
  }
  requireHash(candidate.stateHash);
  return { ...candidate };
}

function requireOperationId(operationId: string): void {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new TypeError("Invalid operation ID");
}

function requireHash(hash: string): void {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new TypeError("Invalid state hash");
}

function requireTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError("Invalid timestamp");
}

function sameIdentity(row: DocumentRow, identity: PlatformDocumentIdentity): boolean {
  return row.tenant_id === identity.tenantId && row.doc_id === identity.docId && row.doc_type === identity.docType
    && row.owner_actor_id === identity.ownerActorId && row.schema_version === identity.schemaVersion;
}

function fromDocumentRow(row: DocumentRow): PlatformDocumentIdentity {
  return { tenantId: row.tenant_id, docId: row.doc_id, docType: row.doc_type,
    ownerActorId: row.owner_actor_id, schemaVersion: row.schema_version };
}

async function digestCandidate(identity: PlatformDocumentIdentity, candidate: PlatformCommitCandidate): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    identity.tenantId, identity.docId, identity.docType, identity.ownerActorId, identity.schemaVersion,
    candidate.operationId, candidate.baseVersion, candidate.stateHash,
  ]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function digestCreation(identity: PlatformDocumentIdentity, stateHash: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    identity.tenantId, identity.docId, identity.docType, identity.ownerActorId, identity.schemaVersion, stateHash,
  ]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function parseReceipt(value: string): PlatformCommitReceipt {
  const receipt = JSON.parse(value) as PlatformCommitReceipt;
  requireOperationId(receipt.operationId);
  requireHash(receipt.requestDigest);
  if (!Number.isSafeInteger(receipt.baseVersion) || receipt.baseVersion < 1) throw new Error("Invalid stored receipt");
  if (receipt.state === "pending") return receipt;
  if (receipt.state === "committed" && receipt.version === receipt.baseVersion + 1) return receipt;
  if (receipt.state === "rejected" && receipt.reason === "version_conflict"
    && Number.isSafeInteger(receipt.headVersion) && receipt.headVersion >= 1) return receipt;
  throw new Error("Invalid stored receipt");
}