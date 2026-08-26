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
 * `idFromName` here is the identity function. `get(id)`
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

import type { DocumentType } from "@unidocs/protocol";
import type { SessionDeps, SessionIdentity } from "@unidocs/doctype-server-common";
import { createSessionHandler, DocumentSession } from "@unidocs/doctype-server-common";

/** Matches server-core's `DoNamespaceLike` structurally. */
export interface LocalNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface PrivateDocRequestContext {
  readonly authKind: "legacy" | "capability";
  readonly delegatedCasCapability?: string;
}

function identityFromRequest(request: Request): SessionIdentity {
  const sessionId = request.headers.get("X-Session-Id");
  if (!sessionId) throw new Error("Missing X-Session-Id header");
  const tenantId = request.headers.get("X-Tenant-Id");
  if (!tenantId) throw new Error("Missing X-Tenant-Id header");
  return {
    docType: request.headers.get("X-Doc-Type") ?? "unknown",
    sessionId,
    tenantId,
  };
}

/**
 * Builds the `editor` namespace `createDocTypeHandler` forwards editor
 * endpoints (`query`, `apply`, `history`, `rollback`, `export`, `snapshot`,
 * `ir`, `init_from_hash`, plus `PUT /sessions/{sessionId}` create) to.
 *
 * `buildDeps` is called fresh on every `fetch()` — see the module doc for why
 * that matters. It is the caller's job to make it cheap (a `pg.Pool` and a
 * `BlobServiceClient` are already connection-pooled internally; constructing
 * the port objects around them per request is not a new network handshake).
 */
export function createLocalEditorNamespace<TDoc, TQuery, TOp>(
  buildSession: (identity: SessionIdentity, requestContext: PrivateDocRequestContext) => {
    documentType: DocumentType<TDoc, TQuery, TOp>;
    deps: SessionDeps;
  },
  prepareSession: (
    identity: SessionIdentity,
    creating: boolean,
  ) => Promise<Response | null>,
): LocalNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        const identity = identityFromRequest(request);
        const requestContext = requestContextFromRequest(request);
        const creating = request.method === "POST"
          && (new URL(request.url).pathname === "/_internal/create"
            || new URL(request.url).pathname === "/_internal/init_from_hash");
        const identityError = await prepareSession(identity, creating);
        if (identityError) return identityError;
        const { documentType, deps } = buildSession(identity, requestContext);
        const session = new DocumentSession(documentType, deps);
        const handle = createSessionHandler({
          session,
          identity,
        });
        return handle(request);
      },
    }),
  };
}

function requestContextFromRequest(request: Request): PrivateDocRequestContext {
  const authKind = request.headers.get("X-UniDocs-Auth-Context");
  if (authKind !== "legacy" && authKind !== "capability") {
    throw new Error("Missing private Doc auth context");
  }
  const delegatedCasCapability = request.headers.get("X-UniDocs-CAS-Capability") ?? undefined;
  return {
    authKind,
    ...(delegatedCasCapability === undefined ? {} : { delegatedCasCapability }),
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
