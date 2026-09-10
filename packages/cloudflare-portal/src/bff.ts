import { AdminAccessError } from "@unidocs/portal-service";
import { clearedAdminCookie, createAdminAuthenticator, hashSessionSecret, SESSION_TTL_SECONDS, sessionTokenFromCookie } from "./auth.js";
import { D1PortalAuthRepository } from "./auth-repository.js";
import { createPortalGoogleLogin, LOGIN_COOKIE } from "./google-login.js";
import type { PortalGoogleConfig } from "./google-config.js";

export const ADMIN_CSRF_COOKIE = "__Host-unidocs_admin_csrf";

export function createPortalBff(config: PortalGoogleConfig, repository: D1PortalAuthRepository, options: {
  readonly bootstrapEmail: string | null;
  readonly now?: () => number;
  readonly googleFetch?: typeof fetch;
}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const login = createPortalGoogleLogin(config, {
    now, put: transaction => repository.put(transaction), take: (state, browser, time) => repository.take(state, browser, time), fetch: options.googleFetch,
  });
  const authenticate = createAdminAuthenticator({ origin: config.origin, audience: config.clientId }, {
    now,
    findSession: hash => repository.findSession(hash),
    findMemberById: memberId => repository.findMemberById(memberId),
    findMemberByIdentity: identity => repository.findMemberByIdentity(identity),
  });
  function csrfCookie(token: string, maxAge: number) {
    return `${ADMIN_CSRF_COOKIE}=${token}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAge}`;
  }

  return async function handle(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    let response: Response;
    try {
      if (url.origin !== config.origin) throw new AdminAccessError("forbidden");
      const methods: Record<string, string> = { "/admin/auth/login": "GET", "/admin/auth/callback": "GET", "/admin/auth/session": "GET", "/admin/auth/logout": "POST" };
      const method = methods[url.pathname];
      if (!method) response = new Response(null, { status: 404 });
      else if (request.method !== method) response = new Response(null, { status: 405, headers: { Allow: method } });
      else if (url.pathname === "/admin/auth/login") response = await login.begin(request);
      else if (url.pathname === "/admin/auth/callback") {
        const completed = await login.complete(request);
        const issued = await repository.completeLogin(completed.identity, options.bootstrapEmail, requestId);
        const headers = new Headers({ Location: new URL(completed.returnTo, config.origin).href });
        headers.append("Set-Cookie", completed.clearLoginCookie);
        headers.append("Set-Cookie", issued.cookie);
        headers.append("Set-Cookie", csrfCookie(issued.csrfToken, SESSION_TTL_SECONDS));
        response = new Response(null, { status: 303, headers });
      } else {
        const context = await authenticate(request);
        if (url.pathname === "/admin/auth/session") {
          response = Response.json({ memberId: context.memberId, email: context.identity.email, authenticatedAt: context.identity.authenticatedAt, transport: context.transport });
        } else {
          if (context.transport !== "session") throw new AdminAccessError("forbidden");
          const hash = await hashSessionSecret(sessionTokenFromCookie(request.headers.get("cookie")));
          await repository.revokeSession(hash, context.memberId, requestId);
          const headers = new Headers();
          headers.append("Set-Cookie", clearedAdminCookie());
          headers.append("Set-Cookie", csrfCookie("", 0));
          response = new Response(null, { status: 204, headers });
        }
      }
    } catch (error) {
      const accessError = error instanceof AdminAccessError;
      const code = accessError ? error.code : "internal_error";
      response = Response.json({ error: { code, message: accessError ? error.message : "Administrator operation failed", requestId } }, { status: accessError ? code === "unauthorized" ? 401 : 403 : 500 });
      if (url.pathname === "/admin/auth/callback") response.headers.append("Set-Cookie", `${LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.headers.set("X-Request-ID", requestId);
    return response;
  };
}