import {
  decodeSValue,
  encodeSValue,
  isSBlob,
  SValueContentType,
} from "@unidocs/core";
import type {
  DocumentFormat,
  DocumentType,
  DocumentTypeContext,
  DocumentTypeFactory,
  SBlob,
  SValue,
  SValueType,
} from "@unidocs/core";
import {
  createSBlob,
  encodeSValueWithRefs,
} from "@unidocs/core/internal";
import { CasClient, CasClientError } from "./cas-client.js";
import type { ApplyResult, HistoryEntry } from "./history.js";
import { createSBlobContext } from "./sblob-context.js";

const KEY_DOC_TYPE = "docType";
const KEY_DOC_ID = "docId";
const KEY_USER_ID = "userId";
const SNAPSHOT_DELTA_THRESHOLD = 10;

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
}

interface SnapshotRow {
  readonly version: number;
  readonly root_hash: string;
  readonly timestamp: number;
}

export interface DocContext {
  readonly docType: string;
  readonly docId: string;
}

export interface SnapshotRecord {
  readonly version: number;
  readonly hash: string;
  readonly timestamp: number;
}

export interface Env {
  readonly SNAPSHOTS_DB: D1Database;
  readonly CAS_SERVICE: Fetcher;
  readonly INTERNAL_TOKEN: string;
  readonly CAS?: R2Bucket;
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
    #cas: CasClient | null = null;
    #userId: string | null = null;
    #docId: string | null = null;
    #docType: string | null = null;

    constructor(ctx: DurableObjectState, env: Env) {
      this.#ctx = ctx;
      this.#env = env;
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
          root_hash TEXT NOT NULL
        )
      `);
      this.#ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS svalue_snapshots (
          version INTEGER PRIMARY KEY,
          root_hash TEXT NOT NULL,
          timestamp INTEGER NOT NULL
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
    }

    #initializeRuntime(userId: string): void {
      if (this.#context) return;
      const cas = new CasClient({
        fetcher: this.#env.CAS_SERVICE,
        userId,
        internalToken: this.#env.INTERNAL_TOKEN,
      });
      const context = createSBlobContext(cas);
      this.#cas = cas;
      this.#context = context;
      this.#config = factory(context);
    }

    async #ensureLoaded(): Promise<void> {
      if (this.#loaded) return;
      this.#initializeSchema();
      const [userId, docId, docType] = await Promise.all([
        this.#ctx.storage.get<string>(KEY_USER_ID),
        this.#ctx.storage.get<string>(KEY_DOC_ID),
        this.#ctx.storage.get<string>(KEY_DOC_TYPE),
      ]);
      this.#userId = userId ?? null;
      this.#docId = docId ?? null;
      this.#docType = docType ?? null;
      if (userId) {
        this.#initializeRuntime(userId);
        await this.#settlePending();
        this.#version = this.#latestVersion();
        if (this.#version > 0) this.#doc = await this.#reconstruct(this.#version);
      }
      this.#loaded = true;
    }

    async #recoverPending(): Promise<void> {
      if (!this.#config) return;
      const before = this.#version;
      await this.#settlePending();
      this.#version = this.#latestVersion();
      if (this.#version !== before || (this.#version > 0 && this.#doc === null)) {
        this.#doc = await this.#reconstruct(this.#version);
      }
    }

    #latestVersion(): number {
      const rows = this.#ctx.storage.sql.exec(
        "SELECT MAX(version) AS max_version FROM svalue_deltas",
      ).toArray();
      return Number(rows[0]?.max_version ?? 0);
    }

    #latestSnapshotVersion(): number {
      const rows = this.#ctx.storage.sql.exec(
        "SELECT MAX(version) AS max_version FROM svalue_snapshots",
      ).toArray();
      return Number(rows[0]?.max_version ?? 0);
    }

    #pending(): PendingRow | null {
      const rows = this.#ctx.storage.sql.exec(
        "SELECT version, timestamp, description, delta_hash, delta_bytes, snapshot_hash, snapshot_bytes FROM svalue_pending WHERE singleton = 1",
      ).toArray();
      return (rows[0] as unknown as PendingRow | undefined) ?? null;
    }

    async #settlePending(): Promise<void> {
      const pending = this.#pending();
      if (!pending) return;
      const context = this.#requireContext();
      const cas = this.#requireCas();
      const docId = this.#requireDocId();
      const deltaBytes = toBytes(pending.delta_bytes);
      await context.makeSBlob(pending.delta_hash, async () => ({
        data: deltaBytes,
        contentType: SValueContentType,
      }));

      const assignments = [{
        owner: `doc:${docId}:delta:${pending.version}`,
        hash: pending.delta_hash,
      }];
      if (pending.snapshot_hash !== null) {
        const snapshotBytes = toBytes(pending.snapshot_bytes);
        await context.makeSBlob(pending.snapshot_hash, async () => ({
          data: snapshotBytes,
          contentType: SValueContentType,
        }));
        assignments.push({
          owner: `doc:${docId}:snapshot:${pending.version}`,
          hash: pending.snapshot_hash,
        });
      }

      await cas.assignRoots({
        requestId: `doc:${docId}:version:${pending.version}:roots`,
        assignments,
      });

      this.#ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO svalue_deltas (version, timestamp, description, root_hash) VALUES (?, ?, ?, ?)",
        pending.version,
        pending.timestamp,
        pending.description,
        pending.delta_hash,
      );
      if (pending.snapshot_hash !== null) {
        this.#ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO svalue_snapshots (version, root_hash, timestamp) VALUES (?, ?, ?)",
          pending.version,
          pending.snapshot_hash,
          pending.timestamp,
        );
        await this.#recordGlobalSnapshot({
          version: pending.version,
          hash: pending.snapshot_hash,
          timestamp: pending.timestamp,
        });
      }
      this.#ctx.storage.sql.exec("DELETE FROM svalue_pending WHERE singleton = 1");
    }

    async #commit(
      doc: SValueType<TDoc>,
      delta: ApplyDelta<TOp> | { readonly kind: "restore" },
      description: string,
      forceSnapshot = false,
    ): Promise<number> {
      const context = this.#requireContext();
      const nextVersion = this.#version + 1;
      const timestamp = Date.now();
      const shouldSnapshot = forceSnapshot
        || nextVersion === 1
        || nextVersion - this.#latestSnapshotVersion() >= SNAPSHOT_DELTA_THRESHOLD;

      let snapshotBlob: SBlob | null = null;
      let snapshotBytes: Uint8Array | null = null;
      if (shouldSnapshot) {
        try {
          snapshotBytes = encodeSValue(doc as unknown as SValue);
          snapshotBlob = await context.makeSBlob({
            data: snapshotBytes,
            contentType: SValueContentType,
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
        deltaBlob = await context.makeSBlob({
          data: deltaBytes,
          contentType: SValueContentType,
        });
      } catch (err) {
        throw new Error(`Store delta root failed: ${String(err)}`);
      }

      this.#ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO svalue_pending
          (singleton, version, timestamp, description, delta_hash, delta_bytes, snapshot_hash, snapshot_bytes)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        nextVersion,
        timestamp,
        description,
        deltaBlob.hash,
        deltaBytes,
        snapshotBlob?.hash ?? null,
        snapshotBytes,
      );
      try {
        await this.#settlePending();
      } catch (err) {
        throw new Error(`Finalize pending version failed: ${String(err)}`);
      }
      this.#version = nextVersion;
      this.#doc = doc;
      await this.#touchDocumentIndex(timestamp);
      return nextVersion;
    }

    async #reconstruct(targetVersion: number): Promise<SValueType<TDoc>> {
      const config = this.#requireConfig();
      const snapshotRows = this.#ctx.storage.sql.exec(
        "SELECT version, root_hash, timestamp FROM svalue_snapshots WHERE version <= ? ORDER BY version DESC LIMIT 1",
        targetVersion,
      ).toArray() as unknown as SnapshotRow[];

      let doc: SValueType<TDoc>;
      let baseVersion: number;
      if (snapshotRows.length > 0) {
        doc = await this.#readDocumentRoot(snapshotRows[0].root_hash);
        baseVersion = snapshotRows[0].version;
      } else {
        doc = await config.init();
        baseVersion = 0;
      }

      const deltaRows = this.#ctx.storage.sql.exec(
        "SELECT version, timestamp, description, root_hash FROM svalue_deltas WHERE version > ? AND version <= ? ORDER BY version ASC",
        baseVersion,
        targetVersion,
      ).toArray() as unknown as DeltaRow[];
      for (const row of deltaRows) {
        const event = await this.#readDeltaRoot(row.root_hash);
        if (event.kind === "restore") {
          doc = await this.#readDocumentBlob(event.doc);
        } else {
          doc = await config.apply(event.operations, doc);
          encodeSValue(doc as unknown as SValue);
        }
      }
      return doc;
    }

    async #readDeltaRoot(hash: string): Promise<StoredDelta<TOp>> {
      const value = await this.#readRootValue(createSBlob(hash));
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

    async #readDocumentRoot(hash: string): Promise<SValueType<TDoc>> {
      return this.#readDocumentBlob(createSBlob(hash));
    }

    async #readDocumentBlob(blob: SBlob): Promise<SValueType<TDoc>> {
      return await this.#readRootValue(blob) as unknown as SValueType<TDoc>;
    }

    async #readRootValue(blob: SBlob): Promise<SValue> {
      const stored = await this.#requireContext().readSBlob(blob);
      if (stored.contentType !== SValueContentType) {
        throw new Error(`Root ${blob.hash} is not an SValue node`);
      }
      return decodeSValue(stored.data);
    }

    async #refreshCurrentRefs(): Promise<void> {
      if (this.#doc === null) return;
      const refs = encodeSValueWithRefs(this.#doc as unknown as SValue).refs;
      try {
        await Promise.all([...new Set(refs)].map(hash => this.#requireCas().leaseExisting(hash)));
      } catch (err) {
        if (!(err instanceof CasClientError) || (err.status !== 404 && err.status !== 409)) throw err;
        this.#doc = await this.#reconstruct(this.#version);
        const rebuiltRefs = encodeSValueWithRefs(this.#doc as unknown as SValue).refs;
        await Promise.all([...new Set(rebuiltRefs)].map(hash => this.#requireCas().leaseExisting(hash)));
      }
    }

    async #ensureCurrentSnapshot(): Promise<string> {
      const rows = this.#ctx.storage.sql.exec(
        "SELECT version, root_hash, timestamp FROM svalue_snapshots WHERE version = ?",
        this.#version,
      ).toArray() as unknown as SnapshotRow[];
      if (rows.length > 0) return rows[0].root_hash;

      const bytes = encodeSValue(this.#requireDoc() as unknown as SValue);
      const blob = await this.#requireContext().makeSBlob({
        data: bytes,
        contentType: SValueContentType,
      });
      await this.#requireCas().assignRoots({
        requestId: `doc:${this.#requireDocId()}:snapshot:${this.#version}:ensure`,
        assignments: [{
          owner: `doc:${this.#requireDocId()}:snapshot:${this.#version}`,
          hash: blob.hash,
        }],
      });
      const timestamp = Date.now();
      this.#ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO svalue_snapshots (version, root_hash, timestamp) VALUES (?, ?, ?)",
        this.#version,
        blob.hash,
        timestamp,
      );
      await this.#recordGlobalSnapshot({ version: this.#version, hash: blob.hash, timestamp });
      return blob.hash;
    }

    async #recordGlobalSnapshot(snapshot: SnapshotRecord): Promise<void> {
      if (!this.#docType || !this.#docId) return;
      await this.#env.SNAPSHOTS_DB.exec(
        "CREATE TABLE IF NOT EXISTS snapshots (hash TEXT NOT NULL, doc_type TEXT NOT NULL, doc_id TEXT NOT NULL, version INTEGER NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY (doc_type, doc_id, version))",
      );
      await this.#env.SNAPSHOTS_DB.prepare(
        "INSERT OR REPLACE INTO snapshots (hash, doc_type, doc_id, version, timestamp) VALUES (?, ?, ?, ?, ?)",
      ).bind(snapshot.hash, this.#docType, this.#docId, snapshot.version, snapshot.timestamp).run();
    }

    async #touchDocumentIndex(timestamp: number): Promise<void> {
      if (!this.#docType || !this.#docId || !this.#userId) return;
      await this.#env.SNAPSHOTS_DB.exec(
        "CREATE TABLE IF NOT EXISTS docs (doc_id TEXT NOT NULL, doc_type TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (doc_id, doc_type))",
      );
      await this.#env.SNAPSHOTS_DB.prepare(
        `INSERT INTO docs (doc_id, doc_type, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(doc_id, doc_type) DO UPDATE SET updated_at = excluded.updated_at`,
      ).bind(this.#docId, this.#docType, this.#userId, timestamp, timestamp).run();
    }

    async #handleRequest(request: Request): Promise<Response> {
      await this.#ensureLoaded();
      try {
        await this.#recoverPending();
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/_internal/create") {
          return await this.#create(request);
        }
        if (request.method === "POST" && url.pathname === "/_internal/init_from_hash") {
          return await this.#initFromHash(request);
        }

        const identityError = this.#verifyIdentity(request);
        if (identityError) return identityError;
        if (this.#doc === null) {
          return Response.json({ success: false, error: "Document not initialized" }, { status: 404 });
        }

        if (request.method === "GET" && url.pathname === "/_internal/export") {
          await this.#refreshCurrentRefs();
          const formatName = url.searchParams.get("format") ?? this.#requireConfig().defaultFormat;
          const format = this.#requireConfig().formats[formatName];
          if (!format) {
            return Response.json({ success: false, error: `Unknown format: ${formatName}` }, { status: 400 });
          }
          const bytes = await format.save(this.#requireDoc());
          const extension = format.extensions[0] ?? "";
          return new Response(Uint8Array.from(bytes).buffer, {
            headers: {
              "Content-Type": format.mediaTypes[0] ?? "application/octet-stream",
              "Content-Disposition": `attachment; filename="${this.#requireDocId()}${extension}"`,
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
          const stored = await this.#requireContext().readSBlob(value.blob);
          return new Response(Uint8Array.from(stored.data).buffer, {
            headers: {
              "Content-Type": stored.contentType,
              "X-UniDocs-SBlob-Hash": value.blob.hash,
            },
          });
        }

        if (request.method === "POST" && url.pathname === "/_internal/apply") {
          const value = await readRequestValue(request);
          if (!isRecord(value)
            || !Array.isArray(value.operations)
            || typeof value.description !== "string"
            || typeof value.baseVersion !== "number"
            || !Number.isSafeInteger(value.baseVersion)) {
            return Response.json({ success: false, error: "Invalid apply request" }, { status: 400 });
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
          let sql = "SELECT version, timestamp, description, root_hash FROM svalue_deltas";
          if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
          sql += " ORDER BY version ASC";
          const rows = this.#ctx.storage.sql.exec(sql, ...params).toArray() as unknown as DeltaRow[];
          const entries: HistoryEntry<TOp>[] = [];
          for (const row of rows) {
            const event = await this.#readDeltaRoot(row.root_hash);
            entries.push({
              version: row.version,
              timestamp: new Date(row.timestamp).toISOString(),
              description: row.description,
              operations: event.kind === "apply"
                ? [...event.operations] as unknown as TOp[]
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
            docId: this.#docId,
          });
        }

        return Response.json({ success: false, error: `Unknown endpoint: ${url.pathname}` }, { status: 404 });
      } catch (err) {
        const status = err instanceof CasClientError
          ? err.status === 404 ? 400 : err.status === 409 ? 409 : 502
          : 500;
        return Response.json({
          success: false,
          error: String(err),
          version: this.#version,
        }, { status });
      }
    }

    async #create(request: Request): Promise<Response> {
      if (this.#docType !== null) {
        return Response.json({ success: false, error: "Document already exists" }, { status: 409 });
      }
      const identity = requestIdentity(request, this.#ctx.id.toString());
      this.#initializeRuntime(identity.userId);
      const config = this.#requireConfig();
      let doc: SValueType<TDoc>;
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const sourceId = formData.get("sourceId");
        if (typeof sourceId === "string" && sourceId.length > 0) {
          return Response.json({ success: false, error: "Use init_from_hash for clone" }, { status: 400 });
        }
        const file = formData.get("file") as unknown;
        if (isUploadedFile(file)) {
          const requested = formData.get("format");
          const format = selectFormat(
            config,
            typeof requested === "string" ? requested : null,
            file.type,
            file.name,
          );
          doc = await format.load(new Uint8Array(await file.arrayBuffer()));
        } else {
          doc = await config.init();
        }
      } else {
        doc = await config.init();
      }
      encodeSValue(doc as unknown as SValue);
      await this.#storeIdentity(identity);
      const version = await this.#commit(doc, { kind: "restore" }, "Document created", true);
      return Response.json({ success: true, docId: identity.docId, version });
    }

    async #initFromHash(request: Request): Promise<Response> {
      if (this.#docType !== null) {
        return Response.json({ success: false, error: "Document already exists" }, { status: 409 });
      }
      const identity = requestIdentity(request, this.#ctx.id.toString());
      this.#initializeRuntime(identity.userId);
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
      return Response.json({ success: true, docId: identity.docId, version });
    }

    async #storeIdentity(identity: { userId: string; docId: string; docType: string }): Promise<void> {
      await Promise.all([
        this.#ctx.storage.put(KEY_USER_ID, identity.userId),
        this.#ctx.storage.put(KEY_DOC_ID, identity.docId),
        this.#ctx.storage.put(KEY_DOC_TYPE, identity.docType),
      ]);
      this.#userId = identity.userId;
      this.#docId = identity.docId;
      this.#docType = identity.docType;
    }

    #verifyIdentity(request: Request): Response | null {
      const userId = request.headers.get("X-User-Id");
      if (!userId) return Response.json({ error: "Missing X-User-Id header" }, { status: 401 });
      if (userId !== this.#userId) {
        return Response.json({ error: "Document owner mismatch" }, { status: 403 });
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

    #requireCas(): CasClient {
      if (!this.#cas) throw new Error("CAS client is not initialized");
      return this.#cas;
    }

    #requireDoc(): SValueType<TDoc> {
      if (this.#doc === null) throw new Error("Document is not loaded");
      return this.#doc;
    }

    #requireDocId(): string {
      if (!this.#docId) throw new Error("Document ID is not initialized");
      return this.#docId;
    }
  };
}

function requestIdentity(
  request: Request,
  fallbackDocId: string,
): { userId: string; docId: string; docType: string } {
  const userId = request.headers.get("X-User-Id");
  if (!userId) throw new Error("Missing X-User-Id header");
  return {
    userId,
    docId: request.headers.get("X-Doc-Id") ?? fallbackDocId,
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

function selectFormat<TDoc, TQuery, TOp>(
  config: DocumentType<TDoc, TQuery, TOp>,
  requested: string | null,
  mediaType: string,
  filename: string,
): DocumentFormat<TDoc> {
  if (requested) {
    const explicit = config.formats[requested];
    if (!explicit) throw new Error(`Unknown format: ${requested}`);
    return explicit;
  }
  const byMediaType = Object.values(config.formats).filter(format =>
    format.mediaTypes.some(candidate => candidate.toLowerCase() === mediaType.toLowerCase()));
  if (byMediaType.length === 1) return byMediaType[0];
  const lowerName = filename.toLowerCase();
  const byExtension = Object.values(config.formats).filter(format =>
    format.extensions.some(extension => lowerName.endsWith(extension.toLowerCase())));
  if (byExtension.length === 1) return byExtension[0];
  if (byMediaType.length > 1 || byExtension.length > 1) throw new Error("Ambiguous document format");
  const fallback = config.formats[config.defaultFormat];
  if (!fallback) throw new Error(`Default format ${config.defaultFormat} is not configured`);
  return fallback;
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
