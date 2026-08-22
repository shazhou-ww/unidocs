/**
 * EditorDO — Cloudflare adapter for `DocumentSession` (@unidocs/server-core).
 *
 * Everything about *how a document evolves* — in-memory state, snapshot +
 * replay reconstruction, the delta write order, the snapshot threshold —
 * lives in `DocumentSession`. Everything about *how a request becomes a
 * response* — the `/_internal/*` routing and the typed-error-to-status-code
 * mapping — lives in `createSessionHandler` (@unidocs/server-core), shared
 * with every other transport adapter. This class is the Cloudflare-shaped
 * shell around both and owns exactly three things:
 *
 *   1. serializing requests per Durable Object (`#requestTail`)
 *   2. building `SessionDeps` from `ctx` / `env` / request headers
 *   3. calling `createSessionHandler`, and persisting the document's
 *      identity to DO storage once `create` / `init_from_hash` succeeds
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
 *   GET  /_internal/ir              — get current IR bytes directly
 *   POST /_internal/init_from_hash  — initialize from existing snapshot hash (for clone)
 */

import type { DocumentType } from "@unidocs/core";
import {
  createSessionHandler,
  DocumentSession,
  errorResponse,
  type DocIdentity,
  type SessionDeps,
} from "@unidocs/server-core";
import { CasClient } from "./cas-client.js";
import {
  D1DocIndex,
  DirectUnitOfWork,
  DoDeltaLog,
  DoSnapshotCache,
  R2BlobCas,
} from "./ports-cf.js";

// DO storage keys for the document's immutable identity. The values are
// load-bearing: changing them orphans every already-deployed document.
const KEY_DOC_TYPE = "docType";
const KEY_DOC_ID = "docId";
const KEY_USER_ID = "userId";

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
     * NOT purely a performance optimization. Correctness of the conditional
     * write itself is guaranteed by `DeltaLog.append` (ports-cf.ts
     * `DoDeltaLog`), whose conditional insert only accepts `head + 1` and
     * otherwise throws `VersionConflictError` — that part holds with or
     * without this queue. But `DocumentSession.apply()`'s root-refs failure
     * path still leans on single-writer ordering: `deltas.remove(nextVersion)`
     * is only safe to run unconditionally-in-effect because this queue
     * guarantees nothing else can have appended on top of `nextVersion` yet.
     * `remove()` is now conditional on the port side too (only removes the
     * current head), so a stray call is a no-op rather than a torn log, but
     * the queue is still what keeps that compensation path simple and
     * effectively single-writer here. Phase 2 (Azure, stateless replicas, no
     * queue) must confirm the root-refs-failure path is fully correct under
     * true concurrency before this can be dropped — see the design doc and
     * the `remove()` sentinels in port-contract.ts.
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
     *
     * `KEY_USER_ID` was introduced after documents already existed, so a doc
     * created before it will have `storedDocType` but no stored `userId`. If
     * that fell back to the literal "anonymous", `#requireUser` would then
     * reject every request for that document with 403 (the caller's real
     * `X-User-Id` never equals "anonymous"). Fall back to the request's
     * `X-User-Id` header instead: on Cloudflare it is the same value that
     * would have been stored — the DO is addressed by
     * `idFromName("{userId}:{docId}")` and both workers set the header from
     * that same path segment — so this recovers the correct owner instead of
     * locking the document. "anonymous" remains only the last resort, for
     * the (routing-broken) case where even the header is missing.
     */
    async #resolveIdentity(request: Request): Promise<DocIdentity> {
      const storedDocType = await this.#ctx.storage.get<string>(KEY_DOC_TYPE);
      if (storedDocType) {
        return {
          docType: storedDocType,
          docId: (await this.#ctx.storage.get<string>(KEY_DOC_ID)) ?? this.#ctx.id.toString(),
          userId:
            (await this.#ctx.storage.get<string>(KEY_USER_ID)) ??
            request.headers.get("X-User-Id") ??
            "anonymous",
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

      const deltas = new DoDeltaLog(this.#ctx);
      const index = new D1DocIndex(this.#env.SNAPSHOTS_DB, identity);

      const deps: SessionDeps = {
        deltas,
        snapshots: new DoSnapshotCache(this.#ctx),
        blobs: new R2BlobCas(this.#env.CAS),
        index,
        // Pass-through, not a transaction: DO sqlite and D1 are separate
        // services with nothing to commit across. See DirectUnitOfWork.
        unitOfWork: new DirectUnitOfWork({ deltas, index }),
        cas: this.#makeCasClient(identity.userId),
        identity,
        now: () => Date.now(),
      };

      this.#session = new DocumentSession(config, deps);
      this.#sessionKey = key;
      return this.#session;
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
      const identity = await this.#resolveIdentity(request);
      const session = this.#openSession(identity);

      const handle = createSessionHandler({
        session,
        identity,
        requesterId: request.headers.get("X-User-Id"),
      });
      const response = await handle(request);

      // `create` / `init_from_hash` promote the header-derived identity into
      // durable storage once the document actually exists. Only on success:
      // an error response (DocExistsError, a rejected clone, ...) must leave
      // the DO's stored identity untouched.
      const endpoint = new URL(request.url).pathname;
      if (
        response.ok &&
        (endpoint === "/_internal/create" || endpoint === "/_internal/init_from_hash")
      ) {
        // This write happens after createSessionHandler's own try/catch has
        // already returned, so a storage failure here would otherwise escape
        // as an uncaught exception instead of the usual JSON error contract.
        // Reuse the same `errorResponse` mapping so it still comes back as
        // `{ success: false, version, error }` / 500, matching the
        // pre-refactor behavior where this call lived inside that catch.
        try {
          await this.#persistIdentity(identity);
        } catch (err) {
          return errorResponse(err, session.version);
        }
      }

      return response;
    }
  };
}
