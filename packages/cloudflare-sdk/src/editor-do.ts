/**
 * EditorDO — Cloudflare adapter for `DocumentSession` (@unidocs/server-core).
 *
 * Everything about *how a document evolves* — in-memory state, snapshot +
 * replay reconstruction, the delta write order, the snapshot threshold —
 * lives in `DocumentSession`. This class is the Cloudflare-shaped shell around
 * it and owns exactly four things:
 *
 *   1. serializing requests per Durable Object (`#requestTail`)
 *   2. building `SessionDeps` from `ctx` / `env` / request headers
 *   3. parsing the `/_internal/*` HTTP surface
 *   4. mapping the typed errors of server-core onto status codes (`#errorResponse`)
 *
 * Storage layout (unchanged — see ports-cf.ts for the SQL):
 *   DO KV storage : docType / docId / userId (immutable identity), snapshot
 *   DO sqlite     : deltas(version PK, timestamp, description, operations)
 *                   snapshots(version PK, hash, timestamp)
 *   Shared D1     : snapshots(hash, doc_type, doc_id, version, timestamp)
 *                   docs(doc_id, doc_type, owner_id, created_at, updated_at)
 *   R2 CAS        : hash -> document bytes
 *
 * Internal endpoints (called by the doc-type worker):
 *   POST /_internal/create          — create new document (multipart/form-data)
 *   POST /_internal/query           — query document (body: TQuery) -> { data, version }
 *   POST /_internal/apply           — apply delta (body: { operations[], description, baseVersion }) -> { version }
 *   GET  /_internal/export          — download document as binary
 *   GET  /_internal/history         — get delta history
 *   POST /_internal/rollback        — rollback to version (body: { version })
 *   GET  /_internal/snapshot        — get current snapshot hash (for clone)
 *   POST /_internal/init_from_hash  — initialize from existing snapshot hash (for clone)
 */

import type { DocumentType } from "@unidocs/core";
import {
  DeltaRejectedError,
  DocExistsError,
  DocNotFoundError,
  DocumentSession,
  RootRefsError,
  StorageCorruptError,
  VersionConflictError,
  type DocIdentity,
  type SessionDeps,
} from "@unidocs/server-core";
import { CasClient, CasClientError } from "./cas-client.js";
import type { ApplyResult } from "./history.js";
import {
  D1DocIndex,
  DoDeltaLog,
  DoSnapshotCache,
  R2BlobCas,
} from "./ports-cf.js";

// DO storage keys for the document's immutable identity. The values are
// load-bearing: changing them orphans every already-deployed document.
const KEY_DOC_TYPE = "docType";
const KEY_DOC_ID = "docId";
const KEY_USER_ID = "userId";

const NOT_INITIALIZED = "Document not initialized. POST /{docType}/ to create.";

export interface DocContext {
  docType: string;
  docId: string;
}

export interface SnapshotRecord {
  version: number;
  hash: string;
  timestamp: number;
}

export interface Env {
  SNAPSHOTS_DB: D1Database;
  CAS: R2Bucket;
  CAS_SERVICE: Fetcher;
  INTERNAL_TOKEN: string;
}

export interface EditorDOInstance {
  fetch(request: Request): Promise<Response>;
}

export type EditorDOClass = new (ctx: DurableObjectState, env: Env) => EditorDOInstance;

export function createEditorDO<TDoc, TQuery, TOp>(config: DocumentType<TDoc, TQuery, TOp>): EditorDOClass {
  return class EditorDO {
    #ctx: DurableObjectState;
    #env: Env;

    /**
     * Serializes requests to this Durable Object.
     *
     * This is a **performance optimization, not a correctness mechanism**.
     * Correctness of concurrent writes is guaranteed by `DeltaLog.append`
     * (ports-cf.ts `DoDeltaLog`), whose conditional insert only accepts
     * `head + 1` and otherwise throws `VersionConflictError`. The queue simply
     * keeps two requests for the same document from replaying the delta log
     * against each other and from doing work that one of them would then lose.
     * Removing it would still be correct, only slower and noisier.
     */
    #requestTail: Promise<void> = Promise.resolve();

    #session: DocumentSession<TDoc, TQuery, TOp> | null = null;
    #sessionKey: string | null = null;
    #tablesReady = false;

    constructor(ctx: DurableObjectState, env: Env) {
      this.#ctx = ctx;
      this.#env = env;
    }

    // ----------------------------------------------------------------
    // Dependency construction
    // ----------------------------------------------------------------

    #makeCasClient(userId: string): CasClient {
      return new CasClient({
        fetcher: this.#env.CAS_SERVICE,
        userId,
        internalToken: this.#env.INTERNAL_TOKEN,
      });
    }

    /**
     * The document's identity. Persisted in DO storage by `create` /
     * `init_from_hash`; every later request reads it back from there. Requests
     * that arrive before the document exists fall back to the headers the
     * doc-type worker sets, so an uninitialized DO still has a coherent
     * identity to build ports with.
     */
    async #resolveIdentity(request: Request): Promise<DocIdentity> {
      const storedDocType = await this.#ctx.storage.get<string>(KEY_DOC_TYPE);
      if (storedDocType) {
        return {
          docType: storedDocType,
          docId: (await this.#ctx.storage.get<string>(KEY_DOC_ID)) ?? this.#ctx.id.toString(),
          userId: (await this.#ctx.storage.get<string>(KEY_USER_ID)) ?? "anonymous",
        };
      }
      return {
        docType: request.headers.get("X-Doc-Type") || "unknown",
        docId: request.headers.get("X-Doc-Id") || this.#ctx.id.toString(),
        userId: request.headers.get("X-User-Id") || "anonymous",
      };
    }

    async #persistIdentity(identity: DocIdentity): Promise<void> {
      await this.#ctx.storage.put(KEY_DOC_TYPE, identity.docType);
      await this.#ctx.storage.put(KEY_DOC_ID, identity.docId);
      await this.#ctx.storage.put(KEY_USER_ID, identity.userId);
    }

    /**
     * The session is cached for the lifetime of the DO so its in-memory
     * document survives between requests. It is rebuilt only if the identity
     * changed under it — which happens exactly once, when `create` promotes a
     * header-derived identity into stored state.
     */
    #openSession(identity: DocIdentity): DocumentSession<TDoc, TQuery, TOp> {
      if (!this.#tablesReady) {
        DoDeltaLog.ensureTables(this.#ctx);
        this.#tablesReady = true;
      }

      const key = `${identity.docType} ${identity.docId} ${identity.userId}`;
      if (this.#session && this.#sessionKey === key) return this.#session;

      const deps: SessionDeps = {
        deltas: new DoDeltaLog(this.#ctx),
        snapshots: new DoSnapshotCache(this.#ctx),
        blobs: new R2BlobCas(this.#env.CAS),
        index: new D1DocIndex(this.#env.SNAPSHOTS_DB, identity),
        cas: this.#makeCasClient(identity.userId),
        identity,
        now: () => Date.now(),
      };

      this.#session = new DocumentSession(config, deps);
      this.#sessionKey = key;
      return this.#session;
    }

    // ----------------------------------------------------------------
    // Error mapping — the single place status codes are decided
    // ----------------------------------------------------------------

    /**
     * The response bodies here are asserted verbatim by the e2e suites
     * (scripts/cas-rollback.test.mjs, scripts/editor-characterization.test.mjs,
     * the treespec tree under tests/bootstrap). Field names and message text
     * are part of the contract — do not reword them.
     */
    #errorResponse(err: unknown, version: number): Response {
      if (err instanceof VersionConflictError) {
        return Response.json(
          { success: false, version: err.currentVersion, error: err.message },
          { status: 409 },
        );
      }
      if (err instanceof DeltaRejectedError) {
        // message is already `Delta failed: ...`
        return Response.json({ success: false, version, error: err.message }, { status: 400 });
      }
      if (err instanceof DocExistsError) {
        return Response.json({ success: false, error: err.message }, { status: 409 });
      }
      if (err instanceof DocNotFoundError) {
        return Response.json({ success: false, version, error: err.message }, { status: 404 });
      }
      if (err instanceof RootRefsError) {
        // message is already `CAS root-refs failed: ...`
        return Response.json({ success: false, version, error: err.message }, { status: 502 });
      }
      if (err instanceof StorageCorruptError) {
        // message is already `Snapshot ${hash} not found in R2`
        return Response.json({ success: false, version, error: err.message }, { status: 500 });
      }
      if (err instanceof CasClientError) {
        // Same three-way split the pre-refactor `#leaseFailure` used.
        const status = err.status === 409 ? 409 : err.status === 404 ? 400 : 502;
        return Response.json({ success: false, version, error: err.message }, { status });
      }
      return Response.json({ success: false, error: String(err), version }, { status: 500 });
    }

    #requireUser(request: Request): Response | null {
      if (!request.headers.get("X-User-Id")) {
        return Response.json({ error: "Missing X-User-Id header" }, { status: 401 });
      }
      return null;
    }

    // ----------------------------------------------------------------
    // HTTP
    // ----------------------------------------------------------------

    async fetch(request: Request): Promise<Response> {
      const response = this.#requestTail.then(() => this.#handleRequest(request));
      this.#requestTail = response.then(
        () => undefined,
        () => undefined,
      );
      return response;
    }

    async #handleRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method;
      const endpoint = url.pathname;

      const identity = await this.#resolveIdentity(request);
      const session = this.#openSession(identity);

      try {
        // POST /_internal/create — create new document
        if (method === "POST" && endpoint === "/_internal/create") {
          const contentType = request.headers.get("content-type") || "";
          let file: File | null = null;
          let sourceId: string | null = null;

          if (contentType.includes("multipart/form-data")) {
            const formData = await request.formData();
            file = formData.get("file") as File | null;
            sourceId = formData.get("sourceId") as string | null;
          }

          let bytes: Uint8Array | undefined;
          if (file) {
            bytes = new Uint8Array(await file.arrayBuffer());
          } else if (sourceId) {
            return Response.json(
              { success: false, error: "Clone should be handled at worker level" },
              { status: 400 },
            );
          }

          const created = await session.create({ bytes });
          await this.#persistIdentity(identity);
          return Response.json({ success: true, docId: created.docId, version: created.version });
        }

        // POST /_internal/init_from_hash — checked BEFORE the not-initialized guard
        if (method === "POST" && endpoint === "/_internal/init_from_hash") {
          const body = await request.json() as { hash: string; sourceVersion: number };
          const created = await session.initFromHash(body.hash, body.sourceVersion);
          await this.#persistIdentity(identity);
          return Response.json({ success: true, docId: created.docId, version: created.version });
        }

        // All other endpoints require an initialized document.
        await session.load();
        if (!session.initialized) {
          return Response.json({ success: false, error: NOT_INITIALIZED }, { status: 404 });
        }

        // GET /_internal/export — download document
        if (method === "GET" && endpoint === "/_internal/export") {
          const exported = await session.exportBytes();
          return new Response(exported.bytes, {
            headers: {
              "Content-Type": exported.contentType,
              "Content-Disposition": `attachment; filename="${identity.docId || "document"}"`,
            },
          });
        }

        // POST /_internal/query
        if (method === "POST" && endpoint === "/_internal/query") {
          const unauthorized = this.#requireUser(request);
          if (unauthorized) return unauthorized;

          const q = await request.json() as TQuery;
          const result = await session.query(q);
          return Response.json({ success: true, data: result.data, version: result.version });
        }

        // POST /_internal/apply — apply delta (batch of operations, transactional)
        if (method === "POST" && endpoint === "/_internal/apply") {
          const unauthorized = this.#requireUser(request);
          if (unauthorized) return unauthorized;

          const body = await request.json() as {
            operations: TOp[];
            description: string;
            baseVersion: number;
          };

          const applied = await session.apply(body.operations, body.description, body.baseVersion);
          const result: ApplyResult = { success: true, version: applied.version };
          return Response.json(result);
        }

        // GET /_internal/history
        if (method === "GET" && endpoint === "/_internal/history") {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          const entries = await session.history(
            from === null ? undefined : parseInt(from),
            to === null ? undefined : parseInt(to),
          );
          return Response.json({ success: true, data: entries, version: session.version });
        }

        // POST /_internal/rollback
        if (method === "POST" && endpoint === "/_internal/rollback") {
          const unauthorized = this.#requireUser(request);
          if (unauthorized) return unauthorized;

          const body = await request.json() as { version: number };
          const rolled = await session.rollback(body.version);
          return Response.json({ success: true, version: rolled.version });
        }

        // GET /_internal/snapshot — get current snapshot hash (for clone)
        if (method === "GET" && endpoint === "/_internal/snapshot") {
          const snap = await session.snapshot();
          return Response.json({
            success: true,
            version: snap.version,
            hash: snap.hash,
            docType: snap.docType,
            docId: snap.docId,
          });
        }

        return Response.json({ success: false, error: `Unknown endpoint: ${endpoint}` }, { status: 404 });
      } catch (err) {
        return this.#errorResponse(err, session.version);
      }
    }
  };
}
