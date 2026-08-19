/**
 * CAS HTTP route handlers.
 *
 * Routes:
 *   GET  /v1/cas/nodes/{hash}/content   — read content
 *   GET  /v1/cas/nodes/{hash}/metadata  — read metadata
 *   POST /v1/cas/nodes/{hash}/lease     — claim lease
 *   PUT  /v1/cas/nodes/{hash}/content   — upload content
 *   GET  /v1/cas/usage                  — storage usage
 *   POST /v1/cas/gc                     — trigger GC
 */

import { validateHash } from "@unidocs/cas";

interface CasEnv {
  CAS_DB: D1Database;
  CAS_R2: R2Bucket;
  CAS_DO: DurableObjectNamespace;
}

/**
 * Check if a path is a CAS route.
 */
export function isCasRoute(pathname: string): boolean {
  return pathname.startsWith("/v1/cas");
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

  // /v1/cas/usage
  if (parts.length === 3 && parts[2] === "usage") {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return callCasDO(env, userId, "/usage", "GET");
  }

  // /v1/cas/gc
  if (parts.length === 3 && parts[2] === "gc") {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    return callCasDO(env, userId, "/gc", "POST", request.body);
  }

  // /v1/cas/nodes/{hash}/...
  if (parts.length >= 5 && parts[2] === "nodes") {
    const hash = parts[3];
    const action = parts[4];

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
        if (request.method === "PUT") {
          const uploadToken = request.headers.get("X-CAS-Upload-Token");
          return callCasDO(env, userId, "/upload", "POST", request.body, hash, uploadToken ?? undefined);
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
        return callCasDO(env, userId, "/lease", "POST", request.body, hash);

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 404 });
    }
  }

  return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
}

/**
 * Call the CAS Durable Object for a user.
 */
async function callCasDO(
  env: CasEnv,
  userId: string,
  action: string,
  method: string,
  body?: ReadableStream | null,
  hash?: string,
  uploadToken?: string,
): Promise<Response> {
  const doId = env.CAS_DO.idFromName(userId);
  const stub = env.CAS_DO.get(doId);

  const headers = new Headers();
  headers.set("X-User-Id", userId);
  if (hash) headers.set("X-CAS-Hash", hash);
  if (uploadToken) headers.set("X-CAS-Upload-Token", uploadToken);

  const url = `https://cas-do.internal${action}`;
  try {
    return await stub.fetch(url, { method, headers, body: body ?? undefined });
  } catch (err) {
    console.error("[Gateway] CAS DO call failed:", { userId, action, method, hash, err });
    throw err;
  }
}
