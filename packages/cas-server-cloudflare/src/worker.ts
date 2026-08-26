/**
 * Canonical stack-scoped CAS tenant server (Cloudflare Workers).
 *
 * Task 3 scaffolding: owns the canonical stack protocol surface
 * (`@unidocs/protocol-cas`) and the top-level dispatch selection — `/stacks`
 * is the tenant plane, `/admin` never reaches this worker. Tasks 4-7
 * implement stack-JWT verification, stack-scoped storage/DO keys, the
 * Root Ref domain DO with atomic audit writes, and the audit-reader RPC.
 * Handlers return 501 until then. The legacy tenant-scoped runtime
 * (`@unidocs/cloudflare-cas`) keeps serving the compatibility window and is
 * retired in Task 9/10.
 */

import { matchCasRoute } from "@unidocs/protocol-cas";
import type { CasRoute } from "@unidocs/protocol-cas";

/** Marker that this package is the canonical stack-scoped CAS server. */
export const CAS_SERVER_CLOUDFLARE_PACKAGE = "@unidocs/cas-server-cloudflare" as const;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = matchCasRoute(request.method, url.pathname);
    if (route) {
      return notImplemented(route);
    }
    return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
  },
};

function notImplemented(route: CasRoute): Response {
  // TODO(Task 4+): verify the stack JWT capability, then dispatch to the
  // stack-and-tenant DO partition.
  return Response.json(
    { error: "SERVICE_UNAVAILABLE", message: `CAS ${route.operation} is not implemented yet` },
    { status: 501 },
  );
}
