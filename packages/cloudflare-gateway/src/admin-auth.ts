import { AdminDirectory, AdminDirectoryError, createAdminHandler, type AdminBrowserSession, type AdminTypeDirectory } from "@unidocs/gateway-common";
import { ADMIN_IDLE_MS, SqliteAdminSessionStore, adminRandomToken, type StoredAdminSession } from "./admin-session-store.js";
import type { CloudflareGatewayOAuthIdentityPorts } from "./oauth-identity.js";

const sessionCookie = "__Host-unidocs_admin";

export function createAdminAuth(options: {
  origin: string;
  directory: AdminDirectory;
  sessions: SqliteAdminSessionStore;
  google: CloudflareGatewayOAuthIdentityPorts;
  types?: AdminTypeDirectory;
  now?: () => number;
}) {
  const origin = new URL(options.origin).origin;
  const now = options.now ?? Date.now;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
  const readToken = (request: Request) => {
    const values = (request.headers.get("Cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${sessionCookie}=`));
    return values.length === 1 ? values[0]!.slice(sessionCookie.length + 1) : "";
  };
  const currentSession = async (request: Request): Promise<AdminBrowserSession | null> => {
    const token = readToken(request);
    const session = await options.sessions.read(token, now());
    if (!session) return null;
    const google = await options.google.currentGoogleLogin(request);
    if (!google || google.loginId !== session.loginId || google.subject !== session.actor.subject || google.issuer !== session.actor.issuer
      || google.email.trim().toLowerCase() !== session.actor.email || google.expiresAt <= now()) return null;
    await options.directory.current(session.actor);
    await options.sessions.touch(token, now());
    return session;
  };
  const api = createAdminHandler({ origin, directory: options.directory, currentSession, now, types: options.types });
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/admin/")) return null;
    if (url.origin !== origin) return json({ error: { code: "invalid_origin" } }, 403);
    try {
      if (url.pathname === "/admin/auth/login") {
        if (request.method !== "GET") return json({ error: { code: "method_not_allowed" } }, 405);
        return options.google.managementAuthenticationRequired(new Request(`${origin}/admin/?google=complete`));
      }
      if (url.pathname === "/admin/auth/session") {
        if (request.method !== "POST") return json({ error: { code: "method_not_allowed" } }, 405);
        if (request.headers.get("Origin") !== origin || request.headers.get("X-UniDocs-Admin") !== "1") return json({ error: { code: "csrf_rejected" } }, 403);
        const google = await options.google.currentGoogleLogin(request);
        const timestamp = now();
        if (!google || google.expiresAt <= timestamp) return json({ error: { code: "google_login_required", loginUrl: "/admin/auth/login" } }, 401);
        const current = await currentSession(request);
        if (current) return json({ data: { csrfToken: current.csrfToken, expiresAt: current.expiresAt } });
        const administrator = await options.directory.bindGoogleIdentity(google);
        if (google.authenticatedAt + 1000 < Date.parse(administrator.addedAt)) return json({ error: { code: "google_login_required", loginUrl: "/admin/auth/login" } }, 401);
        const token = adminRandomToken();
        const expiresAt = Math.min(google.expiresAt, timestamp + 8 * 60 * 60_000);
        const session: StoredAdminSession = {
          actor: { ...google, email: administrator.email, adminId: administrator.adminId }, loginId: google.loginId,
          csrfToken: adminRandomToken(), authenticatedAt: google.authenticatedAt, expiresAt, idleExpiresAt: Math.min(expiresAt, timestamp + ADMIN_IDLE_MS)
        };
        await options.sessions.put(token, session, timestamp);
        return json({ data: { csrfToken: session.csrfToken, expiresAt } }, 201, { "Set-Cookie": `${sessionCookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((expiresAt - timestamp) / 1000)}` });
      }
      if (url.pathname === "/admin/api/v1/session/logout") {
        if (request.method !== "POST") return json({ error: { code: "method_not_allowed" } }, 405);
        if (request.headers.get("Origin") !== origin) return json({ error: { code: "csrf_rejected" } }, 403);
        const token = readToken(request);
        const session = await options.sessions.read(token, now());
        if (session && request.headers.get("X-CSRF-Token") !== session.csrfToken) return json({ error: { code: "csrf_rejected" } }, 403);
        await options.sessions.revoke(token);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "Set-Cookie": `${sessionCookie}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` } });
      }
      return await api(request);
    } catch (error) {
      return json({ error: { code: error instanceof AdminDirectoryError ? error.code : "admin_unavailable" } }, error instanceof AdminDirectoryError ? error.status : 503);
    }
  };
}