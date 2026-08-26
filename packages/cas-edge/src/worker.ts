/**
 * Public CAS front door. Task 1 freezes the dispatch contract; later tasks
 * implement header stripping and service-binding forwarding.
 *
 * /stacks/... -> CAS_TENANT_SERVICE (strip Cookie / admin session headers)
 * /admin/...  -> CAS_ADMIN_SERVICE  (strip tenant Authorization)
 * other       -> 404
 */
export const CAS_EDGE_DISPATCH = {
  tenantPrefix: "/stacks",
  adminPrefix: "/admin",
} as const;

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (
      pathname === CAS_EDGE_DISPATCH.tenantPrefix
      || pathname.startsWith(`${CAS_EDGE_DISPATCH.tenantPrefix}/`)
      || pathname === CAS_EDGE_DISPATCH.adminPrefix
      || pathname.startsWith(`${CAS_EDGE_DISPATCH.adminPrefix}/`)
    ) {
      return new Response("CAS edge dispatch not implemented", { status: 501 });
    }
    return new Response("Not Found", { status: 404 });
  },
};
