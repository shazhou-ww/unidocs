/**
 * UniDocs API Gateway
 *
 * HTTP proxy that routes requests to document type workers based on a
 * KV registry, and allowlist-proxies public CAS routes to the CAS worker.
 *
 * Registry (KV "unidocs-registry"):
 *   Key: "docType:{type}"  →  Value: "{ workerUrl: string }"
 *
 * Identity:
 *   Public userId comes from the URL path.
 *   Future Bearer tokens must bind to that userId.
 *
 * Internal auth:
 *   Gateway → doc worker / CAS worker: X-Internal-Token
 *   Gateway → CAS worker: X-User-Id from the URL path
 */

import { isPublicCasRoute } from "@unidocs/cloudflare-cas/public";

interface RegistryEntry {
  workerUrl: string;
}

interface Env {
  REGISTRY: KVNamespace;
  SNAPSHOTS_DB: D1Database;
  INTERNAL_TOKEN: string;
  CAS_SERVICE: Fetcher;
  [key: string]: unknown;
}

async function resolveWorkerUrl(env: Env, docType: string): Promise<string | null> {
  const entry = await env.REGISTRY.get<RegistryEntry>(`docType:${docType}`, "json");
  if (entry) return entry.workerUrl;
  const envKey = `${docType.toUpperCase()}_WORKER_URL`;
  const url = env[envKey] as string | undefined;
  return url || null;
}

const EDITOR_METHODS = new Set([
  "apply", "query", "export", "history", "rollback",
  "snapshot", "init_from_hash",
]);

const OPERATOR_METHODS = new Set(["run", "reset"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 3 || parts[0] !== "users") {
      return Response.json({
        error: "Use /users/{userId}/docs/{docType}/* or /users/{userId}/cas/* endpoints",
      }, { status: 404 });
    }

    const userId = parts[1];
    const namespace = parts[2];

    if (namespace === "cas") {
      if (!isPublicCasRoute(request.method, url.pathname)) {
        return Response.json({ error: "Unknown CAS endpoint" }, { status: 404 });
      }
      const headers = new Headers(request.headers);
      headers.set("X-Internal-Token", env.INTERNAL_TOKEN);
      headers.set("X-User-Id", userId);
      return env.CAS_SERVICE.fetch(new Request(request, { headers }));
    }

    if (namespace !== "docs") {
      return Response.json({
        error: "Use /users/{userId}/docs/{docType}/* or /users/{userId}/cas/* endpoints",
      }, { status: 404 });
    }

    const docType = parts[3];
    const docId = parts[4];
    const method = parts[5];

    if (!docType) {
      return Response.json({
        error: "Use /users/{userId}/docs/{docType}/* endpoints",
      }, { status: 404 });
    }

    const workerUrl = await resolveWorkerUrl(env, docType);
    if (!workerUrl) {
      return Response.json({
        error: `Unknown document type: ${docType}`,
      }, { status: 404 });
    }

    if (!docId) {
      if (request.method === "POST") {
        return forwardToWorker(request, workerUrl, userId, docType, env);
      }
      if (request.method === "GET") {
        return listDocuments(env, userId, docType);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (method && (EDITOR_METHODS.has(method) || OPERATOR_METHODS.has(method))) {
      return forwardToWorker(request, workerUrl, userId, docType, env);
    }

    return Response.json({
      error: `Unknown endpoint: ${method}`,
    }, { status: 404 });
  },
};

async function forwardToWorker(
  request: Request,
  workerUrl: string,
  userId: string,
  docType: string,
  env: Env,
): Promise<Response> {
  const originalUrl = new URL(request.url);
  const parts = originalUrl.pathname.split("/").filter(Boolean);
  const targetPath = [parts[0], parts[1], ...parts.slice(4)].join("/");
  const targetUrl = `${workerUrl}/${targetPath}${originalUrl.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (key.toLowerCase() !== "host" && key.toLowerCase() !== "connection") {
      headers.set(key, value);
    }
  }
  headers.set("X-Internal-Token", env.INTERNAL_TOKEN);
  headers.set("X-User-Id", userId);
  headers.set("X-Doc-Type", docType);
  headers.set("Accept-Encoding", "identity");

  try {
    return await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
    });
  } catch (err) {
    return Response.json({
      error: `Document worker unreachable: ${err}`,
    }, { status: 502 });
  }
}

async function listDocuments(
  env: Env,
  userId: string,
  docType: string,
): Promise<Response> {
  await env.SNAPSHOTS_DB.exec(
    "CREATE TABLE IF NOT EXISTS docs (doc_id TEXT NOT NULL, doc_type TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (doc_id, doc_type))",
  );

  const result = await env.SNAPSHOTS_DB
    .prepare("SELECT doc_id, doc_type, owner_id, created_at, updated_at FROM docs WHERE owner_id = ? AND doc_type = ? ORDER BY updated_at DESC")
    .bind(userId, docType)
    .all();

  return Response.json({
    success: true,
    data: result.results,
    count: result.results.length,
  });
}
