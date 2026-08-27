/**
 * Public CAS front door.
 *
 * `/stacks/...` -> CAS_TENANT_SERVICE (strip admin-session cookies and shared
 * secrets; tenant Authorization passes through)
 * `/admin/...`  -> CAS_ADMIN_SERVICE  (strip tenant Bearer Authorization;
 *                  Basic test-account credentials and the opaque admin
 *                  session cookie pass through)
 * `/mcp`        -> CAS_MCP_SERVICE    (preserve MCP Bearer Authorization;
 *                  strip cookies and shared secrets)
 * `/health`     -> edge readiness (never forwarded)
 * other         -> 404
 *
 * The private tenant audit-reader RPC and the legacy internal routes are not
 * under either prefix, so the public front door never reaches them.
 */

export const CAS_EDGE_DISPATCH = {
  tenantPrefix: "/stacks",
  adminPrefix: "/admin",
  mcpPath: "/mcp",
} as const;

/** Headers that never cross from the public door to the tenant service. */
const TENANT_STRIPPED_HEADERS = [
  "cookie",
  "x-internal-token",
  "x-cas-audit-reader-key",
] as const;

/** Headers that never cross from the public door to the admin service. */
const ADMIN_STRIPPED_HEADERS = [
  "x-internal-token",
  "x-cas-audit-reader-key",
] as const;

/** Headers that never cross from the public door to the MCP service. */
const MCP_STRIPPED_HEADERS = [
  "cookie",
  "x-internal-token",
  "x-cas-audit-reader-key",
] as const;

const MCP_METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
]);

const MCP_BROWSER_PATHS = new Set([
  "/oauth/authorize",
  "/oauth/google/callback",
]);

const MCP_TOKEN_PATHS = new Set([
  "/oauth/token",
  "/oauth/register",
]);

const MCP_BROWSER_COOKIE_NAMES = new Set([
  "unicas_mcp_oauth",
  "unicas_mcp_consent",
]);

export interface Env {
  /** Private canonical stack-scoped tenant CAS worker. */
  CAS_TENANT_SERVICE: Fetcher;
  /** Private /admin BFF worker (OIDC session cookie auth). */
  CAS_ADMIN_SERVICE: Fetcher;
  /** Private OAuth-protected control-plane MCP worker. */
  CAS_MCP_SERVICE: Fetcher;
  /** Exact trusted browser origin for public MCP requests. */
  CAS_PUBLIC_ORIGIN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "cas-edge" });
    }
    if (isPrefixed(pathname, CAS_EDGE_DISPATCH.tenantPrefix)) {
      return env.CAS_TENANT_SERVICE.fetch(stripHeaders(request, TENANT_STRIPPED_HEADERS));
    }
    if (isPrefixed(pathname, CAS_EDGE_DISPATCH.adminPrefix)) {
      return env.CAS_ADMIN_SERVICE.fetch(stripAdminHeaders(request));
    }
    if (pathname === CAS_EDGE_DISPATCH.mcpPath) {
      const origin = request.headers.get("Origin");
      if (origin && origin !== env.CAS_PUBLIC_ORIGIN) {
        return Response.json({ error: "MCP_ORIGIN_NOT_ALLOWED" }, { status: 403 });
      }
      return env.CAS_MCP_SERVICE.fetch(stripHeaders(request, MCP_STRIPPED_HEADERS));
    }
    if (MCP_METADATA_PATHS.has(pathname)) {
      return env.CAS_MCP_SERVICE.fetch(stripMcpMetadataHeaders(request));
    }
    if (MCP_BROWSER_PATHS.has(pathname)) {
      return env.CAS_MCP_SERVICE.fetch(stripMcpBrowserHeaders(request));
    }
    if (MCP_TOKEN_PATHS.has(pathname)) {
      return env.CAS_MCP_SERVICE.fetch(stripHeaders(request, MCP_STRIPPED_HEADERS));
    }
    return new Response("Not Found", { status: 404 });
  },
};

function isPrefixed(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Rebuild the request with the named headers removed; everything else kept. */
function stripHeaders(request: Request, names: readonly string[]): Request {
  const headers = new Headers(request.headers);
  for (const name of names) headers.delete(name);
  return new Request(request, { headers });
}

function stripAdminHeaders(request: Request): Request {
  const sanitized = stripHeaders(request, ADMIN_STRIPPED_HEADERS);
  const headers = new Headers(sanitized.headers);
  const authorization = headers.get("Authorization");
  if (!authorization || !/^Basic\s+/i.test(authorization)) {
    headers.delete("Authorization");
  }
  return new Request(sanitized, { headers });
}

function stripMcpMetadataHeaders(request: Request): Request {
  const sanitized = stripHeaders(request, MCP_STRIPPED_HEADERS);
  const headers = new Headers(sanitized.headers);
  headers.delete("Authorization");
  return new Request(sanitized, { headers });
}

function stripMcpBrowserHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  const cookies = (headers.get("Cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => MCP_BROWSER_COOKIE_NAMES.has(cookie.split("=", 1)[0] ?? ""));
  headers.delete("Authorization");
  headers.delete("X-Internal-Token");
  headers.delete("X-Cas-Audit-Reader-Key");
  if (cookies.length > 0) headers.set("Cookie", cookies.join("; "));
  else headers.delete("Cookie");
  return new Request(request, { headers });
}
