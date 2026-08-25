/**
 * UniDocs CAS worker.
 *
 * Owns CasDurableObject, CAS_DB, and CAS_R2. All requests require
 * X-Internal-Token. Tenant-scoped CAS URLs are reached only via trusted
 * service calls or Gateway translation.
 */

import {
  handleCasRequest,
  handleRootAssignments,
  handleRootRefs,
  handleReadNode,
  isCasRoute,
} from "./cas/routes.js";
import { migrateCasSchema } from "./cas/schema.js";

export { CasDurableObject } from "./cas/do.js";
export { isPublicCasRoute } from "./public-cas-route.js";

interface Env {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
  CAS_DO: DurableObjectNamespace;
  CAS_ACCESS_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = request.headers.get("X-Internal-Token");
    if (!env.CAS_ACCESS_KEY || token !== env.CAS_ACCESS_KEY) {
      return Response.json({ error: "Forbidden" }, { status: 401 });
    }

    const url = new URL(request.url);

    if (url.pathname === "/_internal/root-refs") {
      const tenantId = request.headers.get("X-Tenant-Id");
      if (!tenantId) {
        return Response.json({ error: "Missing X-Tenant-Id header" }, { status: 401 });
      }
      await migrateCasSchema(env.CAS_DB);
      return handleRootRefs(request, env, tenantId);
    }

    if (url.pathname === "/_internal/root-assignments") {
      const tenantId = request.headers.get("X-Tenant-Id");
      if (!tenantId) {
        return Response.json({ error: "Missing X-Tenant-Id header" }, { status: 401 });
      }
      await migrateCasSchema(env.CAS_DB);
      return handleRootAssignments(request, env, tenantId);
    }

    const readNodeMatch = url.pathname.match(/^\/_internal\/nodes\/([^/]+)$/);
    if (readNodeMatch) {
      const tenantId = request.headers.get("X-Tenant-Id");
      if (!tenantId) {
        return Response.json({ error: "Missing X-Tenant-Id header" }, { status: 401 });
      }
      await migrateCasSchema(env.CAS_DB);
      return handleReadNode(request, env, tenantId, readNodeMatch[1]);
    }

    if (isCasRoute(url.pathname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      const tenantId = parts[1];
      await migrateCasSchema(env.CAS_DB);
      return handleCasRequest(request, env, tenantId);
    }

    return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
  },
};
