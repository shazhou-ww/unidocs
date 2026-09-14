import { isLocalDevOrigin, TenantAccessError } from "@unidocs/portal-service";
import { authenticateTenant, D1TenantSessionStore, TENANT_CSRF_COOKIE, TENANT_SESSION_COOKIE, TENANT_SESSION_TTL_SECONDS } from "./session.js";

const SESSION_PATH = "/portal/auth/session";
const LOGOUT_PATH = "/portal/auth/logout";

function sessionCookie(token: string): string {
  return `${TENANT_SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TENANT_SESSION_TTL_SECONDS}`;
}

function csrfCookie(token: string): string {
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

/**
 * `/portal/auth/session` and `/portal/auth/logout`. Any other path returns
 * null so the worker can try the next handler; a method mismatch on one of
 * these two paths is a 405 with Allow, following bff.ts's convention.
 */
export function createTenantSessionHttp(options: {
  readonly origin: string;
  readonly store: D1TenantSessionStore;
  readonly now: () => number;
}): (request: Request, requestId: string) => Promise<Response | null> {
  const { origin, store, now } = options;

  return async function handle(request: Request, requestId: string): Promise<Response | null> {
    const { pathname } = new URL(request.url);

    if (pathname === SESSION_PATH) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      try {
        const context = await authenticateTenant(request, { origin, now: now(), store });
        return Response.json({ tenantId: context.tenantId, principalId: context.principalId });
      } catch (error) {
        if (!(error instanceof TenantAccessError)) throw error;
        // Only an unauthorized (missing/invalid/expired session) request on a
        // loopback origin gets auto-issued, and only when the request also
        // carries none of the signals authenticateTenant treats as untrusted:
        // no Authorization header (Bearer never falls back to a cookie, so it
        // must stay 401, not be upgraded to a fresh session), the request URL
        // origin matches the configured origin (no DNS rebinding), and the
        // request is not marked cross-site.
        //
        // Of these three, the Authorization check is the load-bearing one.
        // authenticateTenant (session.ts) throws "unauthorized" from two
        // different places: immediately when an Authorization header is
        // present (Bearer must never fall back to the cookie), or later, once
        // the origin/cross-site check has already passed, when the session
        // cookie is missing/invalid. So "unauthorized" alone does not tell
        // you which case you're in - without the Authorization check here, a
        // rejected Bearer request would look identical to a plain missing
        // session and get upgraded to a fresh one, turning the local-dev
        // convenience into a CSRF/rebinding amplifier. The origin-match and
        // not-cross-site checks below are defence in depth: once Authorization
        // is confirmed absent, authenticateTenant has already enforced both
        // before it could reach the "unauthorized" throw, so they cannot
        // themselves be false here - they guard against this handler's
        // precondition ever drifting out of sync with session.ts's, not
        // against a request that reaches this line with either one violated.
        if (
          error.code === "unauthorized"
          && isLocalDevOrigin(origin)
          && request.headers.get("authorization") === null
          && new URL(request.url).origin === origin
          && request.headers.get("sec-fetch-site") !== "cross-site"
        ) {
          const { token, csrfToken } = await store.issue("t-local", "user-local", now());
          const headers = new Headers();
          headers.append("Set-Cookie", sessionCookie(token));
          headers.append("Set-Cookie", csrfCookie(csrfToken));
          return Response.json({ tenantId: "t-local", principalId: "user-local" }, { headers });
        }
        return accessErrorResponse(error, requestId);
      }
    }

    if (pathname === LOGOUT_PATH) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
      try {
        const context = await authenticateTenant(request, { origin, now: now(), store });
        if (context.sessionHash) await store.revoke(context.sessionHash);
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
