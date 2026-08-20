/**
 * UniDocs CAS worker.
 *
 * Owns CasDurableObject, CAS_DB, and CAS_R2. All requests require
 * X-Internal-Token. Public CAS URLs are reached only via Gateway proxy.
 */

import { handleCasRequest, handleRootRefs, isCasRoute } from "./cas/routes.js";
import { migrateCasSchema } from "./cas/schema.js";

export { CasDurableObject } from "./cas/do.js";
export { isPublicCasRoute } from "./public-cas-route.js";

interface Env {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
  CAS_DO: DurableObjectNamespace;
  INTERNAL_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = request.headers.get("X-Internal-Token");
    if (!env.INTERNAL_TOKEN || token !== env.INTERNAL_TOKEN) {
      return Response.json({ error: "Forbidden" }, { status: 401 });
    }

    const url = new URL(request.url);

    if (url.pathname === "/_internal/root-refs") {
      const userId = request.headers.get("X-User-Id");
      if (!userId) {
        return Response.json({ error: "Missing X-User-Id header" }, { status: 401 });
      }
      await migrateCasSchema(env.CAS_DB);
      return handleRootRefs(request, env, userId);
    }

    if (isCasRoute(url.pathname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      const userId = parts[1];
      await migrateCasSchema(env.CAS_DB);
      return handleCasRequest(request, env, userId);
    }

    return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
  },
};
