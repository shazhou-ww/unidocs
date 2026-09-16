import { AdminAccessError } from "@unidocs/portal-service";
import type { PortalGoogleConfig } from "../google-config.js";
import { createTenantGoogleLogin, GoogleLoginError, TENANT_LOGIN_COOKIE } from "../google-login.js";
import type { D1TenantLoginRepository } from "./login-repository.js";
import { csrfCookie, sessionCookie } from "./session-http.js";

export const TENANT_LOGIN_PATH = "/portal/auth/login";
export const TENANT_CALLBACK_PATH = "/portal/auth/callback";

type LoginOutcome = "denied" | "failed" | "unavailable";

/**
 * `GET /portal/auth/login` and `GET /portal/auth/callback`. Both are top-level
 * browser navigations, so every failure is a 303 back to the console with a
 * `login=` outcome, never a JSON body. The callback arrives from Google as a
 * cross-site navigation and must never call authenticateTenant, which refuses
 * cross-site requests.
 */
export function createTenantLoginHttp(options: {
  readonly origin: string;
  /** Throws when Google is not configured; read only on these two paths. */
  readonly googleConfig: () => PortalGoogleConfig;
  readonly repository: D1TenantLoginRepository;
  readonly now: () => number;
  readonly googleFetch?: typeof fetch;
}): (request: Request, requestId: string) => Promise<Response | null> {
  const { origin, repository, now } = options;

  function backToConsole(outcome: LoginOutcome, requestId: string, clearLoginCookie: boolean): Response {
    const target = new URL("/portal/", origin);
    target.searchParams.set("login", outcome);
    target.searchParams.set("requestId", requestId);
    const headers = new Headers({ Location: target.href });
    if (clearLoginCookie) headers.append("Set-Cookie", `${TENANT_LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    return new Response(null, { status: 303, headers });
  }

  return async function handle(request: Request, requestId: string): Promise<Response | null> {
    const { pathname } = new URL(request.url);
    if (pathname !== TENANT_LOGIN_PATH && pathname !== TENANT_CALLBACK_PATH) return null;
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const callback = pathname === TENANT_CALLBACK_PATH;

    let login: ReturnType<typeof createTenantGoogleLogin>;
    try {
      login = createTenantGoogleLogin(options.googleConfig(), {
        now,
        fetch: options.googleFetch,
        put: transaction => repository.put(transaction),
        take: (stateHash, browserHash, time) => repository.take(stateHash, browserHash, time),
      });
    } catch {
      console.warn(JSON.stringify({ event: "tenant_login_not_configured", requestId }));
      return backToConsole("unavailable", requestId, callback);
    }

    try {
      if (!callback) return await login.begin(request);
      const completed = await login.complete(request);
      const issued = await repository.completeLogin(completed.identity, requestId);
      const headers = new Headers({ Location: new URL(completed.returnTo, origin).href });
      headers.append("Set-Cookie", completed.clearLoginCookie);
      headers.append("Set-Cookie", sessionCookie(issued.token));
      headers.append("Set-Cookie", csrfCookie(issued.csrfToken));
      return new Response(null, { status: 303, headers });
    } catch (error) {
      if (error instanceof GoogleLoginError) {
        console.warn(JSON.stringify({ event: "tenant_google_login_failed", requestId, stage: error.stage, reason: error.reason }));
        return backToConsole("failed", requestId, callback);
      }
      if (error instanceof AdminAccessError) {
        // begin refuses a bad returnTo or an unexpected discovery document.
        // The callback's forbidden no longer means "not on the member list"
        // (self-service provisions anyone new a tenant): it means either the
        // confirmation predates the invitation being claimed, or the email
        // is already an active member under a *different* Google identity.
        if (!callback) console.warn(JSON.stringify({ event: "tenant_google_login_failed", requestId, stage: "begin", reason: "validation_failed" }));
        return backToConsole(callback && error.code === "forbidden" ? "denied" : "failed", requestId, callback);
      }
      // Name and message only, as bff.ts: never the stack or the error object.
      console.error(JSON.stringify({
        event: "tenant_operation_failed", requestId, path: pathname,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      }));
      return backToConsole("failed", requestId, callback);
    }
  };
}
