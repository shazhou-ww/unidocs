import { decodeSValue, encodeSValue, isSBlob } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import type { DocumentFormat, DocumentType, DocumentTypeContext, DocumentTypeFactory, SBlob, SValue, SValueType } from "@unidocs/protocol";
import { createSBlob, encodeSValueWithRefs } from "@unidocs/svalue-codec/internal";
import { CasClient, CasClientError } from "@unicas/client";
import {
  byteStreamFromReadableStream,
  DELTA_THRESHOLD,
  readableStreamFromByteStream,
  readableStreamFromSBlobSource,
} from "@unidocs/doctype-server-common";
import type { ApplyResult, HistoryEntry } from "./history.js";
import { createSBlobContext } from "./sblob-context.js";
import { createRequestCasClient } from "./request-cas-client.js";
import { rootTransitionChanges } from "./root-transition.js";

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
  readonly CAS_SERVICE: Fetcher;
  readonly CAS_ACCESS_KEY?: string;
  /** Stack namespace for canonical /stacks routes (stack mode). */
  readonly CAS_STACK_ID?: string;
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
    #requestCas: CasClient | null = null;
    #requestOperation: string | null = null;
    #tenantId: string | null = null;
    #sessionId: string | null = null;
    #docType: string | null = null;
    readonly #recentOps = new Map<string, number>();

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
        ensureNode: (hash: string, content: Uint8Array, contentType: string, refs?: readonly string[]) =>
          this.#requireCas().ensureNode(hash, content, contentType, refs as string[] | undefined),
        leaseExisting: (hash: string) => this.#isReadOnlyOperation()
          ? this.#requireCas().metadata({ kind: "cas", hash })
          : this.#requireCas().leaseExisting(hash),
        storeBlob: (source: import("@unidocs/protocol").SBlobSource) => this.#requireCas().storeBlob(
          readableStreamFromSBlobSource(source),
          {
            contentType: source.contentType,
            ...("data" in source
              ? { size: source.data.length }
              : source.size === undefined ? {} : { size: source.size }),
          },
        ),
        statBlob: (hash: string) => this.#requireCas().statBlob(hash),
        openBlob: async (hash: string, range?: import("@unidocs/protocol").SBlobReadRange) =>
          byteStreamFromReadableStream(range === undefined
            ? await this.#requireCas().openBlob(hash)
            : await this.#requireCas().openBlobRange(hash, range)),
      };
      const context = createSBlobContext(casAdapter, { maxReadBytes: MAX_SVALUE_ROOT_BYTES });
      this.#context = context;
      this.#config = factory(context);
    }

    async #ensureLoaded(): Promise<void> {
      if (this.#loaded) return;
      this.#initializeSchema();
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
      if (tenantId && sessionId && (!storedTenantId || !storedSessionId)) {
        await Promise.all([
          this.#ctx.storage.put(KEY_TENANT_ID, tenantId),
          this.#ctx.storage.put(KEY_SESSION_ID, sessionId),
        ]);
      }
      this.#tenantId = tenantId ?? null;
      this.#sessionId = sessionId ?? null;
      this.#docType = docType ?? null;
      if (this.#tenantId) {
        this.#initializeRuntime();
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
        await cas.updateRootRefs({
          requestId: `session:${sessionId}:version:${pending.version}:roots`,
          changes,
        });
      }

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
        || nextVersion - this.#latestSnapshotVersion() >= DELTA_THRESHOLD;

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
        if (err instanceof CasClientError) throw err;
        throw new Error(`Finalize pending version failed: ${String(err)}`);
      }
      this.#version = nextVersion;
      this.#doc = doc;
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
      await this.#requireCas().updateRootRefs({
        requestId: `session:${this.#requireSessionId()}:snapshot:${this.#version}:ensure`,
        changes: { [blob.hash]: 1 },
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
        await this.#ensureLoaded();
        if (this.#requestCas) {
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

        if (request.method === "POST" && url.pathname === "/_internal/apply") {
          const value = await readRequestValue(request);
          if (!isRecord(value)
            || !Array.isArray(value.operations)
            || typeof value.description !== "string"
            || typeof value.baseVersion !== "number"
            || !Number.isSafeInteger(value.baseVersion)
            || (value.opId !== undefined && typeof value.opId !== "string")) {
            return Response.json({ success: false, error: "Invalid apply request" }, { status: 400 });
          }
          const opId = typeof value.opId === "string" ? value.opId : undefined;
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
      let doc: SValueType<TDoc>;
      const contentType = request.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
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

    #requireCas(): CasClient {
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
        ? this.#requireCas().metadata({ kind: "cas", hash })
        : this.#requireCas().leaseExisting(hash);
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
