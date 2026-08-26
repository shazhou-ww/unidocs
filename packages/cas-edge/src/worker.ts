/**
 * Public CAS front door.
 *
 * `/stacks/...` -> CAS_TENANT_SERVICE (strip admin-session cookies and shared
 * secrets; tenant Authorization passes through)
 * `/admin/...`  -> CAS_ADMIN_SERVICE  (strip tenant Authorization; the opaque
 *                  admin session cookie passes through)
 * `/health`     -> edge readiness (never forwarded)
 * other         -> 404
 *
 * The private tenant audit-reader RPC and the legacy internal routes are not
 * under either prefix, so the public front door never reaches them.
 */

export const CAS_EDGE_DISPATCH = {
  tenantPrefix: "/stacks",
  adminPrefix: "/admin",
} as const;

/** Headers that never cross from the public door to the tenant service. */
const TENANT_STRIPPED_HEADERS = [
  "cookie",
  "x-internal-token",
  "x-cas-audit-reader-key",
] as const;

/** Headers that never cross from the public door to the admin service. */
const ADMIN_STRIPPED_HEADERS = [
  "authorization",
  "x-internal-token",
  "x-cas-audit-reader-key",
] as const;

export interface Env {
  /** Private canonical stack-scoped tenant CAS worker. */
  CAS_TENANT_SERVICE: Fetcher;
  /** Private /admin BFF worker (OIDC session cookie auth). */
  CAS_ADMIN_SERVICE: Fetcher;
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
      return env.CAS_ADMIN_SERVICE.fetch(stripHeaders(request, ADMIN_STRIPPED_HEADERS));
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
