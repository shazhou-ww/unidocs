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
        // loopback origin gets auto-issued. A forbidden one - cross-site or a
        // mismatched origin - is untrusted, and issuing to it would turn the
        // local-dev convenience into a CSRF amplifier.
        if (error.code === "unauthorized" && isLocalDevOrigin(origin)) {
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
