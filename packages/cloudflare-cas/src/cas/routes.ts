/**
 * CAS HTTP route handlers.
 *
 * Service routes (tenantId comes from the URL path):
 *   GET  /tenants/{tenantId}/cas/nodes/{hash}/content   — read content
 *   GET  /tenants/{tenantId}/cas/nodes/{hash}/metadata  — read metadata
 *   POST /tenants/{tenantId}/cas/nodes/{hash}           — lease with content
 *   POST /tenants/{tenantId}/cas/nodes/{hash}/lease     — extend ready node
 *   GET  /tenants/{tenantId}/cas/usage                  — storage usage
 *   POST /tenants/{tenantId}/cas/gc                     — trigger GC
 */

import { validateHash } from "@unidocs/cas-server-common";

interface CasEnv {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
  CAS_DO: DurableObjectNamespace;
}

const FORWARDED_HEADERS = [
  "Content-Type",
  "Content-Length",
  "X-CAS-Refs",
  "X-CAS-Lease-Duration",
];

/**
 * Check if a path is a tenant-scoped CAS service route.
 */
export function isCasRoute(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length >= 3 && parts[0] === "tenants" && parts[2] === "cas";
}

/**
 * POST /_internal/root-refs — Editor-only root-reference updates.
 */
export async function handleRootRefs(
  request: Request,
  env: CasEnv,
  tenantId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  return callCasDO(env, tenantId, "/updateRootRefs", "POST", request.body);
}

/** POST /_internal/root-assignments — owner-bound root updates. */
export async function handleRootAssignments(
  request: Request,
  env: CasEnv,
  tenantId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  return callCasDO(env, tenantId, "/assignRoots", "POST", request.body);
}

/** GET/POST /_internal/nodes/{hash} — portable canonical node bytes. */
export async function handleReadNode(
  request: Request,
  env: CasEnv,
  tenantId: string,
  hash: string,
): Promise<Response> {
  try {
    validateHash(hash);
  } catch {
    return Response.json({ error: "Invalid hash" }, { status: 400 });
  }
  if (request.method === "GET") {
    return callCasDO(env, tenantId, "/readNode", "GET", undefined, hash);
  }
  if (request.method === "POST") {
    return callCasDO(
      env,
      tenantId,
      "/leasePortableNode",
      "POST",
      request.body,
      hash,
      request,
    );
  }
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

/**
 * Handle a CAS HTTP request.
 */
export async function handleCasRequest(
  request: Request,
  env: CasEnv,
  tenantId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  // /tenants/{tenantId}/cas/usage
  if (parts.length === 4 && parts[3] === "usage") {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return callCasDO(env, tenantId, "/usage", "GET");
  }

  // /tenants/{tenantId}/cas/gc
  if (parts.length === 4 && parts[3] === "gc") {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return callCasDO(env, tenantId, "/gc", "POST", request.body);
  }

  // /tenants/{tenantId}/cas/nodes/{hash}
  if (parts.length === 5 && parts[3] === "nodes") {
    const hash = parts[4];
    try {
      validateHash(hash);
    } catch {
      return Response.json({ error: "Invalid hash" }, { status: 400 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return callCasDO(env, tenantId, "/leaseWithContent", "POST", request.body, hash, request);
  }

  // /tenants/{tenantId}/cas/nodes/{hash}/...
  if (parts.length >= 6 && parts[3] === "nodes") {
    const hash = parts[4];
    const action = parts[5];

    try {
      validateHash(hash);
    } catch {
      return Response.json({ error: "Invalid hash" }, { status: 400 });
    }

    switch (action) {
      case "content":
        if (request.method === "GET") {
          return callCasDO(env, tenantId, "/read", "GET", undefined, hash);
        }
        return Response.json({ error: "Method not allowed" }, { status: 405 });

      case "metadata":
        if (request.method !== "GET") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        return callCasDO(env, tenantId, "/metadata", "GET", undefined, hash);

      case "lease":
        if (request.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        return callCasDO(env, tenantId, "/leaseExisting", "POST", undefined, hash, request);

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 404 });
    }
  }

  return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
}

/**
 * Call the CAS Durable Object for one tenant partition.
 */
async function callCasDO(
  env: CasEnv,
  tenantId: string,
  action: string,
  method: string,
  body?: ReadableStream | null,
  hash?: string,
  original?: Request,
): Promise<Response> {
  const doId = env.CAS_DO.idFromName(tenantId);
  const stub = env.CAS_DO.get(doId);

  const headers = new Headers();
  headers.set("X-Tenant-Id", tenantId);
  if (hash) headers.set("X-CAS-Hash", hash);
  if (original) {
    for (const name of FORWARDED_HEADERS) {
      const value = original.headers.get(name);
      if (value) headers.set(name, value);
    }
  }

  const url = `https://cas-do.internal${action}`;
  try {
    return await stub.fetch(url, { method, headers, body: body ?? undefined });
  } catch (err) {
    console.error("[CAS] DO call failed:", { tenantId, action, method, hash, err });
    throw err;
  }
}
