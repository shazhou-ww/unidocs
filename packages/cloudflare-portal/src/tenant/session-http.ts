import { isLocalDevOrigin, TenantAccessError } from "@unidocs/portal-service";
import { authenticateTenant, D1TenantSessionStore, DEV_PRINCIPAL_ID, DEV_TENANT_ID, TENANT_CSRF_COOKIE, TENANT_SESSION_COOKIE, TENANT_SESSION_TTL_SECONDS } from "./session.js";

const SESSION_PATH = "/portal/auth/session";
const LOGOUT_PATH = "/portal/auth/logout";

export function sessionCookie(token: string): string {
  return `${TENANT_SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TENANT_SESSION_TTL_SECONDS}`;
}

export function csrfCookie(token: string): string {
  return `${TENANT_CSRF_COOKIE}=${token}; Path=/; Secure; SameSite=Strict; Max-Age=${TENANT_SESSION_TTL_SECONDS}`;
}

function clearedSessionCookie(): string {
  return `${TENANT_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clearedCsrfCookie(): string {
  return `${TENANT_CSRF_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0`;
}

function accessErrorResponse(error: TenantAccessError, requestId: string): Response {
  return Response.json(
    { error: { code: error.code, message: error.message, requestId } },
    { status: error.code === "unauthorized" ? 401 : 403 },
  );
}

function carriesSessionCookie(request: Request): boolean {
  return (request.headers.get("cookie") ?? "").split(";").some(part => part.trim().split("=", 1)[0] === TENANT_SESSION_COOKIE);
}

/**
 * `/portal/auth/session` and `/portal/auth/logout`. Any other path returns
 * null so the worker can try the next handler; a method mismatch on one of
 * these two paths is a 405 with Allow, following bff.ts's convention.
 */
export function createTenantSessionHttp(options: {
  readonly origin: string;
  readonly store: D1TenantSessionStore;
  readonly now: () => number;
  readonly agentToken?: string;
  readonly devSession: boolean;
}): (request: Request, requestId: string) => Promise<Response | null> {
  const { origin, store, now, agentToken, devSession } = options;

  return async function handle(request: Request, requestId: string): Promise<Response | null> {
    const { pathname } = new URL(request.url);

    if (pathname === SESSION_PATH) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      try {
        const context = await authenticateTenant(request, { origin, now: now(), store, agentToken });
        // An Agent bearer authenticates the tenant API, but it is not a
        // browser session: there is no session to describe here.
        if (context.transport === "bearer") return accessErrorResponse(new TenantAccessError("unauthorized"), requestId);
        return Response.json({ tenantId: context.tenantId, principalId: context.principalId });
      } catch (error) {
        if (!(error instanceof TenantAccessError)) throw error;
        // The local dev session is opt-in (PORTAL_TENANT_DEV_SESSION) and only
        // for a request that carries no session cookie at all: a present but
        // invalid one (expired, revoked, member removed) stays 401 instead of
        // silently becoming someone else. The Authorization check is the
        // load-bearing one of the rest: authenticateTenant throws
        // "unauthorized" both for a rejected bearer and for a missing session,
        // and a rejected bearer must never be upgraded to a session. The origin
        // and cross-site checks repeat what authenticateTenant already enforced
        // before it could throw "unauthorized"; they guard against the two
        // drifting apart.
        if (
          error.code === "unauthorized"
          && devSession
          && request.headers.get("authorization") === null
          && !carriesSessionCookie(request)
          && new URL(request.url).origin === origin
          && request.headers.get("sec-fetch-site") !== "cross-site"
        ) {
          if (!isLocalDevOrigin(origin)) {
            console.warn(JSON.stringify({ event: "tenant_dev_session_ignored", requestId }));
            return accessErrorResponse(error, requestId);
          }
          const { token, csrfToken } = await store.issueDevSession(now());
          const headers = new Headers();
          headers.append("Set-Cookie", sessionCookie(token));
          headers.append("Set-Cookie", csrfCookie(csrfToken));
          return Response.json({ tenantId: DEV_TENANT_ID, principalId: DEV_PRINCIPAL_ID }, { headers });
        }
        return accessErrorResponse(error, requestId);
      }
    }

    if (pathname === LOGOUT_PATH) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
      try {
        const context = await authenticateTenant(request, { origin, now: now(), store, agentToken });
        // Nor is there a session for an Agent bearer to end.
        if (context.transport === "bearer") return accessErrorResponse(new TenantAccessError("unauthorized"), requestId);
        if (context.sessionHash) await store.revoke(context.sessionHash, requestId, now());
        const headers = new Headers();
        headers.append("Set-Cookie", clearedSessionCookie());
        headers.append("Set-Cookie", clearedCsrfCookie());
        return new Response(null, { status: 204, headers });
      } catch (error) {
        if (!(error instanceof TenantAccessError)) throw error;
        return accessErrorResponse(error, requestId);
      }
    }

    return null;
  };
}
