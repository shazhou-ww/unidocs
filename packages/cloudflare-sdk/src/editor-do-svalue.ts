import { decodeSValue, encodeSValue, isSBlob } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import type { DocumentType, DocumentTypeContext, DocumentTypeFactory, SBlob, SValue, SValueType } from "@unidocs/protocol";
import { createSBlob, encodeSValueWithRefs } from "@unidocs/svalue-codec/internal";
import { CasClientError } from "@unicas/tenant-blob-client";
import { createCasBlobClient, leaseNodeContent } from "@unicas/tenant-blob-client";
import {
  AmbiguousFormatError,
  DELTA_THRESHOLD,
  readableStreamFromByteStream,
  readableStreamFromSBlobSource,
  selectFormat,
  UnknownFormatError,
} from "@unidocs/doctype-server-common";
import type { ApplyResult, HistoryEntry } from "./history.js";
import { createSBlobContext } from "./sblob-context.js";
import { createRequestCasClient } from "./request-cas-client.js";
import type { RequestCasClient } from "./request-cas-client.js";
import { rootTransitionChanges } from "./root-transition.js";
import { SqliteCommitJournal, CommitJournalConflict } from "./commit-journal.js";
import { parseCommitRequestIdentity, type CommitReceipt, type CommitRequestIdentity } from "@unidocs/protocol-doc";

const KEY_DOC_TYPE = "docType";
const KEY_SESSION_ID = "sessionId";
const KEY_TENANT_ID = "tenantId";
const LEGACY_OWNER_KEY = "userId";
const LEGACY_DOCUMENT_KEY = "docId";
const RECENT_OP_LIMIT = 1024;
const MAX_SVALUE_ROOT_BYTES = 16 * 1024 * 1024;

interface ApplyDelta<TOp> {
  readonly kind: "apply";
  readonly operations: readonly SValueType<TOp>[];
}

interface RestoreDelta {
  readonly kind: "restore";
  readonly doc: SBlob;
}

type StoredDelta<TOp> = ApplyDelta<TOp> | RestoreDelta;

interface PendingRow {
  readonly commit_op_id: string | null;
  readonly version: number;
  readonly timestamp: number;
  readonly description: string;
  readonly delta_hash: string;
  readonly delta_bytes: ArrayBuffer | Uint8Array;
  readonly snapshot_hash: string | null;
  readonly snapshot_bytes: ArrayBuffer | Uint8Array | null;
}

interface DeltaRow {
  readonly version: number;
  readonly timestamp: number;
  readonly description: string;
  readonly root_hash: string;
  readonly root_bytes?: ArrayBuffer | Uint8Array | null;
}

interface SnapshotRow {
  readonly version: number;
  readonly root_hash: string;
  readonly timestamp: number;
  readonly root_bytes?: ArrayBuffer | Uint8Array | null;
}

export interface Env {
  readonly DOC_EXPLICIT_COMMITS?: string;
  readonly CAS_SERVICE: Fetcher;
  readonly CAS_STACK_ID: string;
  readonly DOC_CAS_CONCURRENCY?: string;
  readonly DOC_MEMORY_PROBE?: string;
}

export interface EditorDOInstance {
  fetch(request: Request): Promise<Response>;
}

export type EditorDOClass = new (
  ctx: DurableObjectState,
  env: Env,
) => EditorDOInstance;

export function createEditorDO<TDoc, TQuery, TOp>(
  factory: DocumentTypeFactory<TDoc, TQuery, TOp>,
): EditorDOClass {
  return class EditorDO implements EditorDOInstance {
    readonly #ctx: DurableObjectState;
    readonly #env: Env;
    #requestTail: Promise<void> = Promise.resolve();
    #loaded = false;
    #version = 0;
    #doc: SValueType<TDoc> | null = null;
    #config: DocumentType<TDoc, TQuery, TOp> | null = null;
    #context: DocumentTypeContext | null = null;
    #requestCas: RequestCasClient | null = null;
    #requestOperation: string | null = null;
    #tenantId: string | null = null;
    #sessionId: string | null = null;
    #docType: string | null = null;
    readonly #recentOps = new Map<string, number>();
    #journal: SqliteCommitJournal | null = null;

    constructor(ctx: DurableObjectState, env: Env) {
      this.#ctx = ctx;
      this.#env = env;
    }

    #rememberOp(opId: string, version: number): void {
      this.#recentOps.set(opId, version);
      if (this.#recentOps.size > RECENT_OP_LIMIT) {
        const oldest = this.#recentOps.keys().next().value;
        if (oldest !== undefined) this.#recentOps.delete(oldest);
      }
    }

    fetch(request: Request): Promise<Response> {
      const response = this.#requestTail.then(() => this.#handleRequest(request));
      this.#requestTail = response.then(
        () => undefined,
        () => undefined,
      );
      return response;
    }

    #initializeSchema(): void {
      this.#ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS svalue_deltas (
          version INTEGER PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          description TEXT NOT NULL,
          root_hash TEXT NOT NULL,
          root_bytes BLOB
        )
      `);
      this.#ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS svalue_snapshots (
          version INTEGER PRIMARY KEY,
          root_hash TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          root_bytes BLOB
        )
      `);
      this.#ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS svalue_pending (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          description TEXT NOT NULL,
          delta_hash TEXT NOT NULL,
          delta_bytes BLOB NOT NULL,
          snapshot_hash TEXT,
          snapshot_bytes BLOB
        )
      `);
      this.#ensureColumn("svalue_deltas", "root_bytes", "BLOB");
      this.#ensureColumn("svalue_snapshots", "root_bytes", "BLOB");
      this.#ensureColumn("svalue_pending", "commit_op_id", "TEXT");
    }

    #ensureColumn(table: string, column: string, type: string): void {
      const columns = this.#ctx.storage.sql.exec(`PRAGMA table_info(${table})`).toArray();
      if (!columns.some(existing => existing.name === column)) {
        this.#ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }

    #initializeRuntime(): void {
      if (this.#context) return;
      const casAdapter = {
        leaseNodeContent: (hash: string, content: Uint8Array, contentType: string, refs?: readonly string[]) =>
          this.#isReadOnlyOperation()
            ? this.#requireCas().unicasClient.readMetadata(hash)
            : leaseNodeContent(this.#requireCas().unicasClient, hash, content, contentType, refs),
        leaseNode: (hash: string) => this.#isReadOnlyOperation()
          ? this.#requireCas().unicasClient.readMetadata(hash)
          : this.#requireCas().unicasClient.leaseNode(hash),
        storeBlob: (source: import("@unidocs/protocol").SBlobSource) => {
          const cas = this.#requireCas();
          const blobs = this.#isReadOnlyOperation()
            ? createCasBlobClient({
              ...cas.unicasClient,
              leaseNode: async hash => {
                await cas.unicasClient.readMetadata(hash);
                return { hash, ready: true, leaseStartedAt: 0, leaseExpiresAt: 0 };
              },
            })
            : cas;
          return blobs.storeBlob(readableStreamFromSBlobSource(source), {
            contentType: source.contentType,
            ...("data" in source
              ? { size: source.data.length }
              : source.size === undefined ? {} : { size: source.size }),
          });
        },
        openBlob: (hash: string) => this.#requireCas().openBlob(hash),
      };
      const casConcurrency = parseCasConcurrency(this.#env.DOC_CAS_CONCURRENCY);
      const context = createSBlobContext(casAdapter, {
        maxReadBytes: MAX_SVALUE_ROOT_BYTES,
        casConcurrency,
        ...(this.#env.DOC_MEMORY_PROBE === "1"
          ? {
              memoryProbe: (sample: import("@unidocs/protocol").DocumentMemoryProbeSample) => {
                console.log({
                  event: "document_memory_probe",
                  docType: this.#docType,
                  sessionId: this.#sessionId,
                  ...sample,
                });
              },
            }
          : {}),
      });
      this.#context = context;
      this.#config = factory(context);
    }

    async #ensureLoaded(): Promise<void> {
      if (this.#loaded) return;
      this.#initializeSchema();
      await this.#loadIdentity(true);
      if (this.#tenantId) {
        this.#initializeRuntime();
        this.#version = this.#latestVersion();
        if (this.#version > 0) this.#doc = await this.#reconstruct(this.#version);
      }
      this.#loaded = true;
    }

    async #loadIdentity(migrate: boolean): Promise<void> {
      const [storedTenantId, storedSessionId, docType, legacyOwner, legacyDocument] = await Promise.all([
        this.#ctx.storage.get<string>(KEY_TENANT_ID),
        this.#ctx.storage.get<string>(KEY_SESSION_ID),
        this.#ctx.storage.get<string>(KEY_DOC_TYPE),
        this.#ctx.storage.get<string>(LEGACY_OWNER_KEY),
        this.#ctx.storage.get<string>(LEGACY_DOCUMENT_KEY),
      ]);
      const tenantId = storedTenantId ?? legacyOwner;
      const sessionId = storedSessionId
        ?? (legacyOwner && legacyDocument ? `${legacyOwner}:${legacyDocument}` : undefined);
      if (migrate && tenantId && sessionId && (!storedTenantId || !storedSessionId)) {
        await Promise.all([
          this.#ctx.storage.put(KEY_TENANT_ID, tenantId),
          this.#ctx.storage.put(KEY_SESSION_ID, sessionId),
        ]);
      }
      this.#tenantId = tenantId ?? null;
      this.#sessionId = sessionId ?? null;
      this.#docType = docType ?? null;
    }

    async #recoverPending(): Promise<void> {
      if (!this.#config) return;
      const before = this.#version;
      await this.#settlePending();
      const version = this.#latestVersion();
      if (version !== before || (version > 0 && this.#doc === null)) {
        this.#doc = await this.#reconstruct(version);
      }
      this.#version = version;
    }

    #latestVersion(): number {
      const rows = this.#ctx.storage.sql.exec(
        "SELECT MAX(version) AS max_version FROM svalue_deltas",
      ).toArray();
      return Number(rows[0]?.max_version ?? 0);
    }

    #commitJournal(): SqliteCommitJournal {
      if (!this.#journal) {
        if (!this.#tenantId || !this.#docType) throw new Error("Commit identity unavailable");
        this.#journal = new SqliteCommitJournal(this.#ctx.storage, {
          tenantId: this.#tenantId, docType: this.#docType, sessionId: this.#requireSessionId(),
        });
      }
      return this.#journal;
    }

    #receiptResponse(receipt: CommitReceipt): Response {
      const status = receipt.state === "committed" ? 200 : receipt.state === "pending" ? 503 : 409;
      return Response.json({ success: receipt.state === "committed", receipt,
        version: receipt.state === "committed" ? receipt.version : this.#version }, { status });
    }

    async #applyExplicit(value: Record<string, unknown>): Promise<Response> {
      try {
        parseCommitRequestIdentity({ opId: value.opId, baseVersion: value.baseVersion, requestDigest: "0".repeat(64) });
      } catch {
        return Response.json({ success: false, error: "Invalid explicit commit identity" }, { status: 400 });
      }
      const pending = this.#pending();
      if (pending && !pending.commit_op_id) {
        return Response.json({ success: false, error: "Legacy pending version requires recovery" }, { status: 409 });
      }
      const journal = this.#commitJournal();
      let receipt: CommitReceipt;
      try {
        receipt = await journal.begin(value.opId as string, {
          baseVersion: value.baseVersion as number, description: value.description as string, operations: value.operations as SValue[],
        });
      } catch (error) {
        if (error instanceof CommitJournalConflict) {
          return Response.json({ success: false, error: error.code }, { status: 409 });
        }
        throw error;
      }
      if (receipt.state !== "pending") return this.#receiptResponse(receipt);
      return this.#resumeExplicit(receipt);
    }

    async #resumeExplicit(receipt: CommitReceipt): Promise<Response> {
      const journal = this.#commitJournal();
      try {
        await this.#recoverPending();
        const current = journal.lookup(receipt);
        if (current.state !== "pending") return this.#receiptResponse(current);
        const intent = await journal.recoverPending();
        if (!intent || intent.receipt.opId !== receipt.opId) throw new Error("Pending commit identity changed");
        if (intent.payload.baseVersion !== this.#version) {
          return this.#receiptResponse(journal.settle({ ...receipt, state: "rejected", reason: "version_conflict", headVersion: this.#version }, () => undefined));
        }
        await this.#refreshCurrentRefs();
        const operations = intent.payload.operations as readonly SValueType<TOp>[];
        let doc: SValueType<TDoc>;
        try {
          doc = await this.#requireConfig().apply(operations, this.#requireDoc());
          encodeSValue(doc as unknown as SValue);
        } catch {
          return this.#receiptResponse(journal.settle({ ...receipt, state: "rejected", reason: "invalid_operations" }, () => undefined));
        }
        await this.#commit(doc, { kind: "apply", operations }, intent.payload.description, false, receipt);
        return this.#receiptResponse(journal.lookup(receipt));
      } catch {
        const current = journal.lookup(receipt);
        if (current.state === "committed") {
          this.#loaded = false;
          this.#doc = null;
        }
        return this.#receiptResponse(current);
      }
    }

    async #handleCommitControl(request: Request, recover: boolean): Promise<Response> {
      let identity: CommitRequestIdentity;
      try {
        const bytes = new Uint8Array(4096);
        let size = 0;
        if (request.body) await request.body.pipeTo(new WritableStream<Uint8Array>({
          write(chunk) {
            if (size + chunk.byteLength <= bytes.length) bytes.set(chunk, size);
            size = Math.min(bytes.length + 1, size + chunk.byteLength);
          },
        }));
        if (size > bytes.length) return Response.json({ error: "Commit control request exceeds 4096 bytes" }, { status: 413 });
        const value = await readRequestValue(new Request(request.url, {
          method: "POST", headers: request.headers, body: bytes.slice(0, size),
        }));
        if (!isRecord(value) || Object.keys(value).some(key => !["opId", "requestDigest", "baseVersion"].includes(key))) {
          throw new Error("Unexpected commit control fields");
        }
        identity = parseCommitRequestIdentity(value);
      } catch {
        return Response.json({ success: false, error: "Invalid commit control identity" }, { status: 400 });
      }
      await this.#loadIdentity(false);
      const identityError = this.#verifyIdentity(request, false);
      if (identityError) return identityError;
      if (this.#env.DOC_EXPLICIT_COMMITS !== "1" || this.#docType !== "markdown") {
        return Response.json({ success: false, error: "Explicit commits are not enabled" }, { status: 400 });
      }
      const journal = new SqliteCommitJournal(this.#ctx.storage, {
        tenantId: this.#tenantId!, docType: this.#docType, sessionId: this.#requireSessionId(),
      }, false);
      try {
        const receipt = journal.lookup(identity);
        if (!recover || receipt.state !== "pending") {
          return Response.json({ receipt }, { headers: { "Cache-Control": "no-store" } });
        }
        if (!this.#requestCas) return Response.json({ error: "Recovery requires delegated CAS authority" }, { status: 403 });
        await this.#ensureLoaded();
        const response = await this.#resumeExplicit(receipt);
        const result = await response.json() as { receipt: CommitReceipt };
        return Response.json({ receipt: result.receipt }, { status: response.status === 503 ? 503 : 200, headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        if (error instanceof CommitJournalConflict) return Response.json({ error: error.code }, { status: 409 });
        return Response.json({ receipt: { ...identity, state: "unknown", reason: "unavailable" } }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }

    #latestSnapshotVersion(): number {
      const rows = this.#ctx.storage.sql.exec(
        "SELECT MAX(version) AS max_version FROM svalue_snapshots",
      ).toArray();
      return Number(rows[0]?.max_version ?? 0);
    }

    #pending(): PendingRow | null {
      const rows = this.#ctx.storage.sql.exec(
        "SELECT version, timestamp, description, delta_hash, delta_bytes, snapshot_hash, snapshot_bytes, commit_op_id FROM svalue_pending WHERE singleton = 1",
      ).toArray();
      return (rows[0] as unknown as PendingRow | undefined) ?? null;
    }

    #latestRootHash(table: "svalue_deltas" | "svalue_snapshots"): string | null {
      const rows = this.#ctx.storage.sql.exec(
        `SELECT root_hash FROM ${table} ORDER BY version DESC LIMIT 1`,
      ).toArray();
      return (rows[0] as unknown as { root_hash: string } | undefined)?.root_hash ?? null;
    }

    async #settlePending(): Promise<void> {
      const pending = this.#pending();
      if (!pending) return;
      const context = this.#requireContext();
      const cas = this.#requireCas();
      const sessionId = this.#requireSessionId();
      const deltaBytes = toBytes(pending.delta_bytes);
      const intent = pending.commit_op_id ? await this.#commitJournal().recoverPending() : null;
      if (pending.commit_op_id) {
        if (!intent || intent.receipt.opId !== pending.commit_op_id || intent.receipt.baseVersion + 1 !== pending.version
          || intent.payload.description !== pending.description) throw new Error("Pending version does not match commit intent");
        const expected = encodeSValue({ kind: "apply", operations: [...intent.payload.operations] });
        if (expected.length !== deltaBytes.length || !expected.every((byte, index) => byte === deltaBytes[index])) {
          throw new Error("Pending delta does not match commit candidate");
        }
      }
      await context.makeSBlob(pending.delta_hash, async () => ({
        data: deltaBytes,
        contentType: SValueContentType,
      }));

      if (pending.snapshot_hash !== null) {
        const snapshotBytes = toBytes(pending.snapshot_bytes);
        await context.makeSBlob(pending.snapshot_hash, async () => ({
          data: snapshotBytes,
          contentType: SValueContentType,
        }));
      }

      const changes = rootTransitionChanges(
        {
          delta: this.#latestRootHash("svalue_deltas"),
          snapshot: this.#latestRootHash("svalue_snapshots"),
        },
        { delta: pending.delta_hash, snapshot: pending.snapshot_hash },
      );
      if (Object.keys(changes).length > 0) {
        await cas.unicasClient.updateRootRefs({
          requestId: intent ? `session:${sessionId}:commit:${intent.receipt.opId}:roots` : `session:${sessionId}:version:${pending.version}:roots`,
          changes,
        });
      }

      const finalize = (): undefined => {
        this.#ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO svalue_deltas
            (version, timestamp, description, root_hash, root_bytes)
           VALUES (?, ?, ?, ?, ?)`,
          pending.version,
          pending.timestamp,
          pending.description,
          pending.delta_hash,
          deltaBytes,
        );
        if (pending.snapshot_hash !== null) {
          const snapshotBytes = toBytes(pending.snapshot_bytes);
          this.#ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO svalue_snapshots
              (version, root_hash, timestamp, root_bytes)
             VALUES (?, ?, ?, ?)`,
            pending.version,
            pending.snapshot_hash,
            pending.timestamp,
            snapshotBytes,
          );
        }
        this.#ctx.storage.sql.exec("DELETE FROM svalue_pending WHERE singleton = 1");
      };
      if (intent) this.#commitJournal().settle({ ...intent.receipt, state: "committed", version: pending.version }, finalize);
      else this.#ctx.storage.transactionSync(finalize);
    }

    async #commit(
      doc: SValueType<TDoc>,
      delta: ApplyDelta<TOp> | { readonly kind: "restore" },
      description: string,
      forceSnapshot = false,
      intent?: CommitRequestIdentity,
    ): Promise<number> {
      const context = this.#requireContext();
      const probe = context.memoryProbe;
      const nextVersion = this.#version + 1;
      const timestamp = Date.now();
      const shouldSnapshot = forceSnapshot
        || nextVersion === 1
        || nextVersion - this.#latestSnapshotVersion() >= DELTA_THRESHOLD;

      let snapshotBlob: SBlob | null = null;
      let snapshotBytes: Uint8Array | null = null;
      probe?.({ stage: "commit.start", details: { nextVersion, shouldSnapshot } });
      if (shouldSnapshot) {
        try {
          snapshotBytes = encodeSValue(doc as unknown as SValue);
          probe?.({
            stage: "commit.snapshot.encoded",
            details: { nextVersion, snapshotBytes: snapshotBytes.length },
          });
          snapshotBlob = await context.makeSBlob({
            data: snapshotBytes,
            contentType: SValueContentType,
          });
          probe?.({
            stage: "commit.snapshot.uploaded",
            details: { nextVersion, snapshotBytes: snapshotBytes.length },
          });
        } catch (err) {
          throw new Error(`Store snapshot root failed: ${String(err)}`);
        }
      }

      let deltaBytes: Uint8Array;
      let deltaBlob: SBlob;
      try {
        const storedDelta: StoredDelta<TOp> = delta.kind === "restore"
          ? { kind: "restore", doc: snapshotBlob! }
          : delta;
        deltaBytes = encodeSValue(storedDelta as unknown as SValue);
        probe?.({
          stage: "commit.delta.encoded",
          details: { nextVersion, deltaBytes: deltaBytes.length },
        });
        deltaBlob = await context.makeSBlob({
          data: deltaBytes,
          contentType: SValueContentType,
        });
        probe?.({
          stage: "commit.delta.uploaded",
          details: { nextVersion, deltaBytes: deltaBytes.length },
        });
      } catch (err) {
        throw new Error(`Store delta root failed: ${String(err)}`);
      }

      this.#ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO svalue_pending
          (singleton, version, timestamp, description, delta_hash, delta_bytes, snapshot_hash, snapshot_bytes, commit_op_id)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nextVersion,
        timestamp,
        description,
        deltaBlob.hash,
        deltaBytes,
        snapshotBlob?.hash ?? null,
        snapshotBytes,
        intent?.opId ?? null,
      );
      probe?.({
        stage: "commit.pending.persisted",
        details: {
          nextVersion,
          deltaBytes: deltaBytes.length,
          snapshotBytes: snapshotBytes?.length ?? 0,
        },
      });
      try {
        await this.#settlePending();
      } catch (err) {
        if (err instanceof CasClientError) throw err;
        throw new Error(`Finalize pending version failed: ${String(err)}`);
      }
      this.#version = nextVersion;
      this.#doc = doc;
      probe?.({ stage: "commit.complete", details: { nextVersion } });
      return nextVersion;
    }

    async #reconstruct(targetVersion: number): Promise<SValueType<TDoc>> {
      const config = this.#requireConfig();
      const snapshotRows = this.#ctx.storage.sql.exec(
        `SELECT version, root_hash, timestamp, root_bytes FROM svalue_snapshots
         WHERE version <= ? ORDER BY version DESC LIMIT 1`,
        targetVersion,
      ).toArray() as unknown as SnapshotRow[];

      let doc: SValueType<TDoc>;
      let baseVersion: number;
      if (snapshotRows.length > 0) {
        doc = await this.#readDocumentRoot(
          snapshotRows[0].root_hash,
          snapshotRows[0].root_bytes,
        );
        baseVersion = snapshotRows[0].version;
      } else {
        doc = await config.init();
        baseVersion = 0;
      }

      const deltaRows = this.#ctx.storage.sql.exec(
        `SELECT version, timestamp, description, root_hash, root_bytes FROM svalue_deltas
         WHERE version > ? AND version <= ? ORDER BY version ASC`,
        baseVersion,
        targetVersion,
      ).toArray() as unknown as DeltaRow[];
      for (const row of deltaRows) {
        const event = await this.#readDeltaRoot(row.root_hash, row.root_bytes);
        if (event.kind === "restore") {
          doc = await this.#readDocumentBlob(event.doc);
        } else {
          doc = await config.apply(event.operations, doc);
          encodeSValue(doc as unknown as SValue);
        }
      }
      return doc;
    }

    async #readDeltaRoot(
      hash: string,
      bytes?: ArrayBuffer | Uint8Array | null,
    ): Promise<StoredDelta<TOp>> {
      const value = await this.#readRootValue(createSBlob(hash), bytes);
      if (!isRecord(value) || (value.kind !== "apply" && value.kind !== "restore")) {
        throw new Error(`Invalid stored delta root ${hash}`);
      }
      if (value.kind === "restore") {
        if (!isSBlob(value.doc)) throw new Error(`Restore delta ${hash} has no document SBlob`);
        return { kind: "restore", doc: value.doc };
      }
      if (!Array.isArray(value.operations)) {
        throw new Error(`Apply delta ${hash} has no operations array`);
      }
      return {
        kind: "apply",
        operations: value.operations as unknown as readonly SValueType<TOp>[],
      };
    }

    async #readDocumentRoot(
      hash: string,
      bytes?: ArrayBuffer | Uint8Array | null,
    ): Promise<SValueType<TDoc>> {
      return await this.#readRootValue(createSBlob(hash), bytes) as unknown as SValueType<TDoc>;
    }

    async #readDocumentBlob(blob: SBlob): Promise<SValueType<TDoc>> {
      const rows = this.#ctx.storage.sql.exec(
        "SELECT root_bytes FROM svalue_snapshots WHERE root_hash = ? AND root_bytes IS NOT NULL LIMIT 1",
        blob.hash,
      ).toArray() as Array<{ root_bytes?: ArrayBuffer | Uint8Array | null }>;
      return await this.#readRootValue(blob, rows[0]?.root_bytes) as unknown as SValueType<TDoc>;
    }

    async #readRootValue(
      blob: SBlob,
      bytes?: ArrayBuffer | Uint8Array | null,
    ): Promise<SValue> {
      if (bytes) return decodeSValue(toBytes(bytes));
      const handler = await this.#requireContext().openSBlob(blob);
      if (handler.contentType !== SValueContentType) {
        throw new Error(`Root ${blob.hash} is not an SValue node`);
      }
      if (handler.size > MAX_SVALUE_ROOT_BYTES) {
        throw new Error(`SValue root exceeds ${MAX_SVALUE_ROOT_BYTES}-byte limit`);
      }
      return decodeSValue(await handler.readBytes({ offset: 0, length: handler.size }));
    }

    async #refreshCurrentRefs(): Promise<void> {
      if (this.#doc === null) return;
      const refs = encodeSValueWithRefs(this.#doc as unknown as SValue).refs;
      try {
        await Promise.all([...new Set(refs)].map(hash => this.#checkExistingRef(hash)));
      } catch (err) {
        if (!(err instanceof CasClientError) || (err.status !== 404 && err.status !== 409)) throw err;
        this.#doc = await this.#reconstruct(this.#version);
        const rebuiltRefs = encodeSValueWithRefs(this.#doc as unknown as SValue).refs;
        await Promise.all([...new Set(rebuiltRefs)].map(hash => this.#checkExistingRef(hash)));
      }
    }

    async #ensureCurrentSnapshot(): Promise<string> {
      const rows = this.#ctx.storage.sql.exec(
        "SELECT version, root_hash, timestamp, root_bytes FROM svalue_snapshots WHERE version = ?",
        this.#version,
      ).toArray() as unknown as SnapshotRow[];
      if (rows.length > 0) return rows[0].root_hash;

      const bytes = encodeSValue(this.#requireDoc() as unknown as SValue);
      const blob = await this.#requireContext().makeSBlob({
        data: bytes,
        contentType: SValueContentType,
      });
      await this.#requireCas().retain({
        requestId: `session:${this.#requireSessionId()}:snapshot:${this.#version}:ensure`,
        references: { [blob.hash]: 1 },
      });
      const timestamp = Date.now();
      this.#ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO svalue_snapshots
          (version, root_hash, timestamp, root_bytes) VALUES (?, ?, ?, ?)`,
        this.#version,
        blob.hash,
        timestamp,
        bytes,
      );
      return blob.hash;
    }

    async #handleRequest(request: Request): Promise<Response> {
      this.#requestCas = createRequestCasClient(this.#env, request);
      this.#requestOperation = request.headers.get("X-UniDocs-Doc-Operation");
      try {
        const url = new URL(request.url);
        if (request.method === "POST" && (url.pathname === "/_internal/commit_status" || url.pathname === "/_internal/commit_recover")) {
          return await this.#handleCommitControl(request, url.pathname === "/_internal/commit_recover");
        }
        await this.#ensureLoaded();
        if (this.#docType !== null) {
          const identityError = this.#verifyIdentity(request, false);
          if (identityError) return identityError;
        }
        const applyValue = request.method === "POST" && url.pathname === "/_internal/apply" ? await readRequestValue(request) : null;
        const explicit = isRecord(applyValue) && applyValue.commitMode === "receipt-v1";
        if (isRecord(applyValue) && applyValue.commitMode !== undefined && (!explicit || this.#env.DOC_EXPLICIT_COMMITS !== "1" || this.#docType !== "markdown")) {
          return Response.json({ success: false, error: "Explicit commits are not enabled or mode is unsupported" }, { status: 400 });
        }
        if (this.#docType !== null && this.#requestCas && !this.#isReadOnlyOperation() && !explicit && this.#commitJournal().pendingIdentity()) {
          if (!request.bodyUsed && request.body) await request.body.pipeTo(new WritableStream({ write() {} }));
          return Response.json({ success: false, error: "Explicit commit pending; recover the original request", version: this.#version }, { status: 409 });
        }
        if (this.#requestCas && !this.#isReadOnlyOperation() && !explicit) {
          await this.#recoverPending();
        }
        if (request.method === "POST" && url.pathname === "/_internal/create") {
          return await this.#create(request);
        }
        if (request.method === "POST" && url.pathname === "/_internal/init_from_hash") {
          return await this.#initFromHash(request);
        }

        if (request.method === "GET" && url.pathname === "/_internal/status") {
          const identityError = this.#verifyIdentity(request, true);
          if (identityError) return identityError;
          return Response.json({ exists: this.#doc !== null, version: this.#version });
        }
        const identityError = this.#verifyIdentity(request, false);
        if (identityError) return identityError;
        if (this.#doc === null) {
          return Response.json({ success: false, error: "Document not initialized" }, { status: 404 });
        }

        if (request.method === "GET" && url.pathname === "/_internal/snapshot-index") {
          const data = this.#ctx.storage.sql.exec(
            "SELECT version, root_hash AS hash FROM svalue_snapshots ORDER BY version ASC",
          ).toArray();
          return Response.json({ success: true, data });
        }

        if (request.method === "GET" && url.pathname === "/_internal/export") {
          await this.#refreshCurrentRefs();
          // `??` only catches `null` (param absent). `?format=` (empty
          // string) must fall back the same way — Azure's session-handler.ts
          // already guards this (`|| undefined`); this side didn't, so
          // `?format=` picked `formats[""]` (always missing) and 400'd
          // instead of exporting the default format like a bare `/export`.
          const formatName = url.searchParams.get("format") || this.#requireConfig().defaultFormat;
          const format = this.#requireConfig().formats[formatName];
          if (!format) {
            return Response.json({ success: false, error: `Unknown format: ${formatName}` }, { status: 400 });
          }
          const bytes = await format.save(this.#requireDoc());
          const extension = format.extensions[0] ?? "";
          return new Response(Uint8Array.from(bytes).buffer, {
            headers: {
              "Content-Type": format.mediaTypes[0] ?? "application/octet-stream",
              "Content-Disposition": `attachment; filename="document${extension}"`,
            },
          });
        }

        if (request.method === "POST" && url.pathname === "/_internal/query") {
          await this.#refreshCurrentRefs();
          const query = await readRequestValue(request) as unknown as SValueType<TQuery>;
          const data = await this.#requireConfig().query(query, this.#requireDoc());
          const envelope = { success: true, data, version: this.#version } as const;
          encodeSValue(envelope);
          return valueResponse(request, envelope);
        }

        if (request.method === "POST" && url.pathname === "/_internal/resolve_blob") {
          const value = await readRequestValue(request);
          if (!isRecord(value) || typeof value.hash !== "string") {
            return Response.json({ success: false, error: "Invalid blob resolution request" }, { status: 400 });
          }
          const blob = await this.#requireContext().makeSBlob(
            value.hash,
            missingStoredBlob(value.hash),
          );
          return valueResponse(request, { blob });
        }

        if (request.method === "POST" && url.pathname === "/_internal/read_blob") {
          const value = await readRequestValue(request);
          if (!isRecord(value) || !isSBlob(value.blob)) {
            return Response.json({ success: false, error: "Invalid blob read request" }, { status: 400 });
          }
          const rangeValue = value.range;
          const range = rangeValue === undefined
            ? undefined
            : isRecord(rangeValue)
              && typeof rangeValue.offset === "number"
              && (rangeValue.length === undefined || typeof rangeValue.length === "number")
              ? { offset: rangeValue.offset, ...(rangeValue.length === undefined ? {} : { length: rangeValue.length }) }
              : null;
          if (range === null) {
            return Response.json({ success: false, error: "Invalid blob read range" }, { status: 400 });
          }
          const handler = await this.#requireContext().openSBlob(value.blob);
          return new Response(readableStreamFromByteStream(handler.read(range)), {
            headers: {
              "Content-Type": handler.contentType,
              "X-UniDocs-SBlob-Size": String(handler.size),
              "X-UniDocs-SBlob-Hash": value.blob.hash,
            },
          });
        }

        if (request.method === "POST" && url.pathname === "/_internal/write_blob") {
          // agent 侧的 effect 工具（图像模型返回的 PNG）是第一个调用方。
          // 身份与 capability 已在上面的 #verifyIdentity 校验过；makeSBlob
          // 是写类操作，靠转发过来的 CAS capability 授权。
          const contentType = request.headers.get("Content-Type");
          if (!contentType) {
            return Response.json({ success: false, error: "write_blob needs a Content-Type" }, { status: 400 });
          }
          const data = new Uint8Array(await request.arrayBuffer());
          if (data.length === 0) {
            return Response.json({ success: false, error: "write_blob got an empty body" }, { status: 400 });
          }
          const blob = await this.#requireContext().makeSBlob({ data, contentType });
          return valueResponse(request, { blob });
        }

        if (request.method === "POST" && url.pathname === "/_internal/apply") {
          const value = applyValue;
          if (!isRecord(value)
            || !Array.isArray(value.operations)
            || typeof value.description !== "string"
            || typeof value.baseVersion !== "number"
            || !Number.isSafeInteger(value.baseVersion)
            || (value.opId !== undefined && typeof value.opId !== "string")) {
            return Response.json({ success: false, error: "Invalid apply request" }, { status: 400 });
          }
          const opId = typeof value.opId === "string" ? value.opId : undefined;
          if (explicit) return await this.#applyExplicit(value);
          if (opId !== undefined) {
            const seenVersion = this.#recentOps.get(opId);
            if (seenVersion !== undefined) {
              return Response.json({ success: true, version: seenVersion });
            }
          }
          if (value.baseVersion !== this.#version) {
            return Response.json({
              success: false,
              version: this.#version,
              error: `Version conflict: baseVersion ${value.baseVersion} does not match current ${this.#version}`,
            }, { status: 409 });
          }
          await this.#refreshCurrentRefs();
          let doc: SValueType<TDoc>;
          const operations = value.operations as unknown as readonly SValueType<TOp>[];
          try {
            doc = await this.#requireConfig().apply(operations, this.#requireDoc());
            encodeSValue(doc as unknown as SValue);
          } catch (err) {
            return Response.json({
              success: false,
              version: this.#version,
              error: `Delta failed: ${String(err)}`,
            }, { status: 400 });
          }
          const version = await this.#commit(
            doc,
            { kind: "apply", operations },
            value.description,
          );
          if (opId !== undefined) this.#rememberOp(opId, version);
          const result: ApplyResult = { success: true, version };
          return Response.json(result);
        }

        if (request.method === "GET" && url.pathname === "/_internal/history") {
          const from = parseOptionalVersion(url.searchParams.get("from"));
          const to = parseOptionalVersion(url.searchParams.get("to"));
          const conditions: string[] = [];
          const params: number[] = [];
          if (from !== null) {
            conditions.push("version >= ?");
            params.push(from);
          }
          if (to !== null) {
            conditions.push("version <= ?");
            params.push(to);
          }
          let sql = "SELECT version, timestamp, description, root_hash, root_bytes FROM svalue_deltas";
          if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
          sql += " ORDER BY version ASC";
          const rows = this.#ctx.storage.sql.exec(sql, ...params).toArray() as unknown as DeltaRow[];
          const entries: HistoryEntry<TOp & SValue>[] = [];
          for (const row of rows) {
            const event = await this.#readDeltaRoot(row.root_hash, row.root_bytes);
            entries.push({
              version: row.version,
              timestamp: new Date(row.timestamp).toISOString(),
              description: row.description,
              operations: event.kind === "apply"
                ? [...event.operations] as Array<TOp & SValue>
                : [],
            });
          }
          const envelope = { success: true, data: entries, version: this.#version };
          return valueResponse(request, envelope as unknown as SValue);
        }

        if (request.method === "POST" && url.pathname === "/_internal/rollback") {
          const value = await readRequestValue(request);
          if (!isRecord(value)
            || typeof value.version !== "number"
            || !Number.isSafeInteger(value.version)) {
            return Response.json({ success: false, error: "Invalid rollback request" }, { status: 400 });
          }
          const target = value.version;
          const exists = this.#ctx.storage.sql.exec(
            "SELECT version FROM svalue_deltas WHERE version = ?",
            target,
          ).toArray().length > 0;
          if (!exists) {
            return Response.json({
              success: false,
              version: this.#version,
              error: `Version ${target} not found`,
            }, { status: 404 });
          }
          const doc = await this.#reconstruct(target);
          const version = await this.#commit(
            doc,
            { kind: "restore" },
            `Rollback to version ${target}`,
            true,
          );
          return Response.json({ success: true, version });
        }

        if (request.method === "GET" && url.pathname === "/_internal/snapshot") {
          await this.#refreshCurrentRefs();
          const hash = await this.#ensureCurrentSnapshot();
          return Response.json({
            success: true,
            version: this.#version,
            hash,
            docType: this.#docType,
          });
        }

        if (request.method === "GET" && url.pathname === "/_internal/ir") {
          await this.#refreshCurrentRefs();
          const bytes = encodeSValue(this.#requireDoc() as unknown as SValue);
          return new Response(Uint8Array.from(bytes).buffer, {
            headers: {
              "Content-Type": SValueContentType,
              "X-Doc-Version": String(this.#version),
            },
          });
        }

        return Response.json({ success: false, error: `Unknown endpoint: ${url.pathname}` }, { status: 404 });
      } catch (err) {
        if (err instanceof UnknownFormatError || err instanceof AmbiguousFormatError) {
          // Same reasoning as the manual `Unknown format` check in the
          // `/_internal/export` branch above: a bad `format` is a client
          // input error, not a server fault. This path only ever reaches
          // `#create`'s `selectFormat` call (import), which the generic
          // catch below would otherwise report as 500 — the Azure side of
          // this had the same bug (`session-handler.ts`'s `errorResponse`).
          return Response.json({
            success: false,
            error: err.message,
            version: this.#version,
          }, { status: 400 });
        }
        const status = err instanceof CasClientError
          ? err.status === 404 ? 400 : err.status === 409 ? 409 : 502
          : 500;
        return Response.json({
          success: false,
          error: String(err),
          version: this.#version,
        }, { status });
      } finally {
        this.#requestCas = null;
        this.#requestOperation = null;
      }
    }

    async #create(request: Request): Promise<Response> {
      if (this.#docType !== null) {
        return Response.json({ success: false, error: "Document already exists" }, { status: 409 });
      }
      const identity = requestIdentity(request);
      this.#initializeRuntime();
      const config = this.#requireConfig();
      const probe = this.#requireContext().memoryProbe;
      probe?.({ stage: "create.start" });
      let doc: SValueType<TDoc>;
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        probe?.({ stage: "create.multipart.parsed" });
        const sourceId = formData.get("sourceId");
        if (typeof sourceId === "string" && sourceId.length > 0) {
          return Response.json({
            success: false,
            error: "Clone should be handled at worker level",
          }, { status: 400 });
        }
        const file = formData.get("file") as unknown;
        if (isUploadedFile(file)) {
          const requested = formData.get("format");
          const { format } = selectFormat(config, {
            // 只有真的给了字符串才传 name。传 undefined 与传 null 在旧签名
            // 里是同一件事(都表示"没指定"),新签名靠键的存在与否区分。
            ...(typeof requested === "string" ? { name: requested } : {}),
            mediaType: file.type,
            filename: file.name,
          });
          const uploadBytes = new Uint8Array(await file.arrayBuffer());
          probe?.({
            stage: "create.upload.buffered",
            details: { uploadBytes: uploadBytes.length },
          });
          doc = await format.load(uploadBytes);
          probe?.({ stage: "create.format.loaded", details: { uploadBytes: uploadBytes.length } });
        } else {
          doc = await config.init();
          probe?.({ stage: "create.document.initialized" });
        }
      } else {
        doc = await config.init();
        probe?.({ stage: "create.document.initialized" });
      }
      const validationBytes = encodeSValue(doc as unknown as SValue);
      probe?.({
        stage: "create.document.validated",
        details: { stateBytes: validationBytes.length },
      });
      await this.#storeIdentity(identity);
      probe?.({ stage: "create.identity.persisted" });
      const version = await this.#commit(doc, { kind: "restore" }, "Document created", true);
      return Response.json({ success: true, sessionId: identity.sessionId, version });
    }

    async #initFromHash(request: Request): Promise<Response> {
      if (this.#docType !== null) {
        return Response.json({ success: false, error: "Document already exists" }, { status: 409 });
      }
      const identity = requestIdentity(request);
      this.#initializeRuntime();
      const value = await readRequestValue(request);
      if (!isRecord(value)
        || typeof value.hash !== "string"
        || typeof value.sourceVersion !== "number"
        || !Number.isSafeInteger(value.sourceVersion)) {
        return Response.json({ success: false, error: "Invalid clone request" }, { status: 400 });
      }
      const doc = await this.#readDocumentRoot(value.hash);
      await this.#storeIdentity(identity);
      const version = await this.#commit(
        doc,
        { kind: "restore" },
        `Cloned from snapshot ${value.hash} (source version ${value.sourceVersion})`,
        true,
      );
      return Response.json({ success: true, sessionId: identity.sessionId, version });
    }

    async #storeIdentity(identity: { tenantId: string; sessionId: string; docType: string }): Promise<void> {
      await Promise.all([
        this.#ctx.storage.put(KEY_TENANT_ID, identity.tenantId),
        this.#ctx.storage.put(KEY_SESSION_ID, identity.sessionId),
        this.#ctx.storage.put(KEY_DOC_TYPE, identity.docType),
      ]);
      this.#tenantId = identity.tenantId;
      this.#sessionId = identity.sessionId;
      this.#docType = identity.docType;
    }

    #verifyIdentity(request: Request, allowMissing: boolean): Response | null {
      const tenantId = request.headers.get("X-Tenant-Id");
      const sessionId = request.headers.get("X-Session-Id");
      if (!tenantId || !sessionId) {
        return Response.json({ error: "Missing tenant or session identity" }, { status: 401 });
      }
      if (this.#tenantId === null && this.#sessionId === null && allowMissing) return null;
      if (tenantId !== this.#tenantId || sessionId !== this.#sessionId) {
        return Response.json({ error: "Session identity mismatch" }, { status: 403 });
      }
      return null;
    }

    #requireConfig(): DocumentType<TDoc, TQuery, TOp> {
      if (!this.#config) throw new Error("Document runtime is not initialized");
      return this.#config;
    }

    #requireContext(): DocumentTypeContext {
      if (!this.#context) throw new Error("SBlob context is not initialized");
      return this.#context;
    }

    #requireCas(): RequestCasClient {
      if (!this.#requestCas) {
        throw new Error("This Doc operation has no delegated CAS authority");
      }
      return this.#requestCas;
    }

    #isReadOnlyOperation(): boolean {
      return this.#requestOperation === "query"
        || this.#requestOperation === "export"
        || this.#requestOperation === "ir";
    }

    #checkExistingRef(hash: string): Promise<unknown> {
      return this.#isReadOnlyOperation()
        ? this.#requireCas().unicasClient.readMetadata(hash)
        : this.#requireCas().unicasClient.leaseNode(hash);
    }

    #requireDoc(): SValueType<TDoc> {
      if (this.#doc === null) throw new Error("Document is not loaded");
      return this.#doc;
    }

    #requireSessionId(): string {
      if (!this.#sessionId) throw new Error("Session ID is not initialized");
      return this.#sessionId;
    }

  };
}

function requestIdentity(
  request: Request,
): { tenantId: string; sessionId: string; docType: string } {
  const tenantId = request.headers.get("X-Tenant-Id");
  if (!tenantId) throw new Error("Missing X-Tenant-Id header");
  const sessionId = request.headers.get("X-Session-Id");
  if (!sessionId) throw new Error("Missing X-Session-Id header");
  return {
    tenantId,
    sessionId,
    docType: request.headers.get("X-Doc-Type") ?? "unknown",
  };
}

function missingStoredBlob(hash: string): () => Promise<never> {
  return async () => {
    throw new Error(`SBlob ${hash} must be uploaded before use`);
  };
}

interface UploadedFile {
  readonly name: string;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  return typeof value === "object"
    && value !== null
    && "name" in value
    && typeof value.name === "string"
    && "type" in value
    && typeof value.type === "string"
    && "arrayBuffer" in value
    && typeof value.arrayBuffer === "function";
}

async function readRequestValue(request: Request): Promise<SValue> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase() === SValueContentType) {
    return decodeSValue(new Uint8Array(await request.arrayBuffer()));
  }
  const json = await request.json();
  return decodeSValue(encodeSValue(json as SValue));
}

function valueResponse(request: Request, value: SValue): Response {
  const encoded = encodeSValueWithRefs(value);
  const acceptsSValue = (request.headers.get("accept") ?? "").includes(SValueContentType)
    || (request.headers.get("content-type") ?? "").toLowerCase() === SValueContentType;
  if (acceptsSValue) {
    return new Response(Uint8Array.from(encoded.data).buffer, {
      headers: { "Content-Type": SValueContentType },
    });
  }
  if (encoded.refs.length > 0) {
    return Response.json({ error: "This response requires the SValue media type" }, { status: 406 });
  }
  return Response.json(value);
}

function parseCasConcurrency(value: string | undefined): number {
  if (value === undefined) return 2;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new TypeError("DOC_CAS_CONCURRENCY must be an integer between 1 and 32");
  }
  return parsed;
}

function parseOptionalVersion(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid version: ${value}`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, SValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isSBlob(value);
}

function toBytes(value: ArrayBuffer | Uint8Array | null): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("Pending root bytes are missing");
}
