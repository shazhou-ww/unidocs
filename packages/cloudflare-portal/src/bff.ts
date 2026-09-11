import { AdminAccessError, type AdminContext } from "@unidocs/portal-service";
import { clearedAdminCookie, createAdminAuthenticator, hashSessionSecret, SESSION_TTL_SECONDS, sessionTokenFromCookie } from "./auth.js";
import { D1PortalAuthRepository } from "./auth-repository.js";
import { createPortalGoogleLogin, GoogleLoginError, LOGIN_COOKIE } from "./google-login.js";
import type { PortalGoogleConfig } from "./google-config.js";
import { isProtectedAdminWebUiPath } from "./static-assets.js";

export const ADMIN_CSRF_COOKIE = "__Host-unidocs_admin_csrf";

export function createPortalBff(config: PortalGoogleConfig, repository: D1PortalAuthRepository, options: {
  readonly bootstrapEmail: string | null;
  readonly now?: () => number;
  readonly googleFetch?: typeof fetch;
  readonly adminApi?: (request: Request, context: AdminContext, requestId: string) => Promise<Response>;
  readonly adminUi?: (request: Request) => Response | null;
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
    const protectedUi = isProtectedAdminWebUiPath(url.pathname);
    let response: Response;
    try {
      if (url.origin !== config.origin) throw new AdminAccessError("forbidden");
      const methods: Record<string, string> = { "/admin": "GET", "/admin/": "GET", "/admin/login": "GET", "/admin/access-denied": "GET", "/admin/auth/login": "GET", "/admin/auth/callback": "GET", "/admin/auth/session": "GET", "/admin/auth/logout": "POST" };
      const method = methods[url.pathname] ?? (protectedUi ? "GET" : undefined);
      if (url.pathname.startsWith("/admin/assets/") && options.adminUi) response = options.adminUi(request) ?? new Response(null, { status: 404 });
      else if (url.pathname.startsWith("/admin/api/v1/") && options.adminApi) response = await options.adminApi(request, await authenticate(request), requestId);
      else if (!method) response = new Response(null, { status: 404 });
      else if (request.method !== method) response = new Response(null, { status: 405, headers: { Allow: method } });
      else if ((url.pathname === "/admin/login" || url.pathname === "/admin/access-denied") && options.adminUi) response = options.adminUi(request) ?? new Response(null, { status: 503 });
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
        if (protectedUi && options.adminUi) {
          response = options.adminUi(request) ?? new Response(null, { status: 503 });
        } else if (url.pathname === "/admin/auth/session" || url.pathname === "/admin/" || url.pathname === "/admin") {
          response = Response.json({
            memberId: context.memberId, email: context.identity.email, authenticatedAt: context.identity.authenticatedAt,
            loginConfirmedAt: context.identity.loginConfirmedAt ?? null, loginConfirmation: context.identity.loginConfirmation ?? null, transport: context.transport
          });
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
      const details = error instanceof GoogleLoginError ? { stage: error.stage, reason: error.reason } : undefined;
      if (details) console.warn(JSON.stringify({ event: "portal_google_login_failed", requestId, ...details }));
      response = Response.json({ error: { code, message: accessError ? error.message : "Administrator operation failed", requestId, ...(details ? { details } : {}) } }, { status: accessError ? code === "unauthorized" ? 401 : 403 : 500 });
      if (accessError && code === "unauthorized" && request.method === "GET" && protectedUi && !request.headers.has("authorization")) {
        response = new Response(null, { status: 303, headers: { Location: `${config.origin}/admin/login` } });
      } else if (accessError && code === "unauthorized" && url.pathname === "/admin/auth/logout"
        && request.method === "POST" && request.headers.get("origin") === config.origin && request.headers.get("sec-fetch-site") !== "cross-site") {
        const headers = new Headers();
        headers.append("Set-Cookie", clearedAdminCookie());
        headers.append("Set-Cookie", csrfCookie("", 0));
        response = new Response(null, { status: 204, headers });
      } else if (accessError && request.method === "GET" && request.headers.get("accept")?.includes("text/html")
        && (url.pathname === "/admin/auth/callback" || protectedUi)) {
        const target = new URL("/admin/access-denied", config.origin);
        target.searchParams.set("code", code);
        target.searchParams.set("requestId", requestId);
        response = new Response(null, { status: 303, headers: { Location: target.href } });
      }
      if (url.pathname === "/admin/auth/callback") response.headers.append("Set-Cookie", `${LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    }
    if (!url.pathname.startsWith("/admin/assets/")) response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Content-Security-Policy", isProtectedAdminWebUiPath(url.pathname) || url.pathname === "/admin/login" || url.pathname === "/admin/access-denied" || url.pathname.startsWith("/admin/assets/")
      ? "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      : "default-src 'none'; frame-ancestors 'none'");
    response.headers.set("X-Request-ID", requestId);
    return response;
  };
}