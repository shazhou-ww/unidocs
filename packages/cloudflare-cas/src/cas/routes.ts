/**
 * CAS HTTP route handlers.
 *
 * Public routes (userId comes from the URL path):
 *   GET  /users/{userId}/cas/nodes/{hash}/content   — read content
 *   GET  /users/{userId}/cas/nodes/{hash}/metadata  — read metadata
 *   POST /users/{userId}/cas/nodes/{hash}           — lease with content
 *   POST /users/{userId}/cas/nodes/{hash}/lease     — extend ready node
 *   GET  /users/{userId}/cas/usage                  — storage usage
 *   POST /users/{userId}/cas/gc                     — trigger GC
 */

import { validateHash } from "@unidocs/cas";

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
 * Check if a path is a public CAS route: /users/{userId}/cas/...
 */
export function isCasRoute(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length >= 3 && parts[0] === "users" && parts[2] === "cas";
}

/**
 * POST /_internal/root-refs — Editor-only root-reference updates.
 */
export async function handleRootRefs(
  request: Request,
  env: CasEnv,
  userId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  return callCasDO(env, userId, "/updateRootRefs", "POST", request.body);
}

/**
 * Handle a CAS HTTP request.
 */
export async function handleCasRequest(
  request: Request,
  env: CasEnv,
  userId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  // /users/{userId}/cas/usage
  if (parts.length === 4 && parts[3] === "usage") {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return callCasDO(env, userId, "/usage", "GET");
  }

  // /users/{userId}/cas/gc
  if (parts.length === 4 && parts[3] === "gc") {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return callCasDO(env, userId, "/gc", "POST", request.body);
  }

  // /users/{userId}/cas/nodes/{hash}
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
    return callCasDO(env, userId, "/leaseWithContent", "POST", request.body, hash, request);
  }

  // /users/{userId}/cas/nodes/{hash}/...
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
          return callCasDO(env, userId, "/read", "GET", undefined, hash);
        }
        return Response.json({ error: "Method not allowed" }, { status: 405 });

      case "metadata":
        if (request.method !== "GET") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        return callCasDO(env, userId, "/metadata", "GET", undefined, hash);

      case "lease":
        if (request.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        return callCasDO(env, userId, "/leaseExisting", "POST", undefined, hash, request);

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 404 });
    }
  }

  return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
}

/**
 * Call the CAS Durable Object for a user.
 * X-User-Id is an internal hop header, not part of the public API.
 */
async function callCasDO(
  env: CasEnv,
  userId: string,
  action: string,
  method: string,
  body?: ReadableStream | null,
  hash?: string,
  original?: Request,
): Promise<Response> {
  const doId = env.CAS_DO.idFromName(userId);
  const stub = env.CAS_DO.get(doId);

  const headers = new Headers();
  headers.set("X-User-Id", userId);
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
    console.error("[CAS] DO call failed:", { userId, action, method, hash, err });
    throw err;
  }
}
