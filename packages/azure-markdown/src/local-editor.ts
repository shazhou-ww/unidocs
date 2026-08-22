/**
 * The "no Durable Object" adapter.
 *
 * `createDocTypeHandler` (server-core) is written against a structural
 * `DoNamespaceLike` — `{ idFromName(name): unknown; get(id): { fetch(req):
 * Promise<Response> } }` — deliberately not Cloudflare's real
 * `DurableObjectNamespace`, so any object with that shape works. On
 * Cloudflare, `get(id)` returns a stub bound to one long-lived DO instance
 * that keeps a `DocumentSession` cached across requests. Azure has no DO: a
 * handful of stateless Node processes stand behind the gateway, so there is
 * no single instance to cache a session on.
 *
 * `idFromName` here is the identity function — the "id" is just the same
 * `{userId}:{docId}` string `createDocTypeHandler` already builds. `get(id)`
 * returns an object whose `fetch` builds a **brand new `DocumentSession`**
 * for that one request and hands it straight to `createSessionHandler`.
 *
 * This throwaway-session-per-request behavior is not a shortcut to be
 * optimized away later with an in-process LRU keyed by doc id. See the
 * class doc on `DocumentSession` (server-core): `apply()` only compares the
 * delta log's `head()` against the caller-supplied `baseVersion`, never
 * against a cached instance's own `#version`, and `load()` is one-shot. A
 * cached session that a *different* Azure replica has since raced ahead of
 * would pass that check (the version is correct) while its in-memory `#doc`
 * is not, and the wrong bytes would land in the snapshot cache tagged with a
 * version number that looks right — with nothing downstream positioned to
 * catch it. A fresh session per request always calls `load()` against
 * current durable state, which is the only way to keep that invariant with
 * no single owning process. See design doc section 9 for the full risk
 * writeup.
 */

import type { DocumentType } from "@unidocs/core";
import {
  createSessionHandler,
  DocumentSession,
  type DocIdentity,
  type SessionDeps,
} from "@unidocs/server-core";

/** Matches server-core's `DoNamespaceLike` structurally. */
export interface LocalNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/**
 * `id`, as handed back by `idFromName`, is always the same
 * `{userId}:{docId}` string `createDocTypeHandler` builds it from — but the
 * request it forwards already carries `X-User-Id` / `X-Doc-Id` / `X-Doc-Type`
 * headers for the same values (it sets them on every forwarded call, see
 * doc-type-handler.ts), so those are read first and `id` is only the
 * fallback for a header that is somehow missing.
 */
function identityFromRequest(request: Request, id: unknown): DocIdentity {
  const idStr = typeof id === "string" ? id : String(id);
  const sep = idStr.indexOf(":");
  const fallbackUserId = sep === -1 ? idStr : idStr.slice(0, sep);
  const fallbackDocId = sep === -1 ? "" : idStr.slice(sep + 1);

  return {
    docType: request.headers.get("X-Doc-Type") ?? "unknown",
    docId: request.headers.get("X-Doc-Id") ?? fallbackDocId,
    userId: request.headers.get("X-User-Id") ?? fallbackUserId ?? "anonymous",
  };
}

/**
 * Builds the `editor` namespace `createDocTypeHandler` forwards editor
 * endpoints (`query`, `apply`, `history`, `rollback`, `export`, `snapshot`,
 * `ir`, `init_from_hash`, plus the bare `POST /users/{userId}/` create) to.
 *
 * `buildDeps` is called fresh on every `fetch()` — see the module doc for why
 * that matters. It is the caller's job to make it cheap (a `pg.Pool` and a
 * `BlobServiceClient` are already connection-pooled internally; constructing
 * the port objects around them per request is not a new network handshake).
 */
export function createLocalEditorNamespace<TDoc, TQuery, TOp>(
  config: DocumentType<TDoc, TQuery, TOp>,
  buildDeps: (identity: DocIdentity) => SessionDeps,
): LocalNamespace {
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (request: Request): Promise<Response> => {
        const identity = identityFromRequest(request, id);
        const session = new DocumentSession(config, buildDeps(identity));
        const handle = createSessionHandler({
          session,
          identity,
          requesterId: request.headers.get("X-User-Id"),
        });
        return handle(request);
      },
    }),
  };
}

/**
 * The `operator` namespace. The ReAct loop (`run`/`reset`) is out of scope
 * for this task — it needs an LLM provider and an editor stub wired up the
 * way `createOperatorDO` does on Cloudflare, which is future work. Every
 * operator endpoint answers 501 so the route exists and fails predictably
 * instead of 404ing or crashing.
 */
export function createStubOperatorNamespace(): LocalNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (): Promise<Response> =>
        Response.json(
          { success: false, error: "Operator is not implemented on Azure yet" },
          { status: 501 },
        ),
    }),
  };
}
