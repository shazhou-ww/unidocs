/**
 * UniDocs API Gateway
 *
 * HTTP proxy that routes requests to document type workers based on a
 * KV registry. No cross-script DO bindings — doc type workers are
 * independently deployed and registered at deploy time.
 *
 * Registry (KV "unidocs-registry"):
 *   Key: "docType:{type}"  →  Value: "{ workerUrl: string }"
 *   Written by CI/CD via `wrangler kv:key put` after deploying each doc worker.
 *
 * URL pattern:
 *   POST /users/{userId}/{docType}/                   → create (forward to worker)
 *   GET  /users/{userId}/{docType}/                   → list (query D1 directly)
 *   POST /users/{userId}/{docType}/{docId}/apply      → forward to worker
 *   POST /users/{userId}/{docType}/{docId}/query      → forward to worker
 *   GET  /users/{userId}/{docType}/{docId}/export     → forward to worker
 *   GET  /users/{userId}/{docType}/{docId}/history    → forward to worker
 *   POST /users/{userId}/{docType}/{docId}/rollback   → forward to worker
 *   GET  /users/{userId}/{docType}/{docId}/snapshot   → forward to worker
 *   POST /users/{userId}/{docType}/{docId}/init_from_hash → forward to worker
 *   POST /users/{userId}/{docType}/{docId}/run        → forward (operator)
 *   POST /users/{userId}/{docType}/{docId}/reset      → forward (operator)
 *
 * Internal auth:
 *   Gateway → doc worker: X-Internal-Token header (shared secret from env)
 *   User → gateway: future (Bearer token, session, etc.)
 */

interface RegistryEntry {
  workerUrl: string;
}

interface Env {
  REGISTRY: KVNamespace;
  SNAPSHOTS_DB: D1Database;
  INTERNAL_TOKEN: string;
  // Env var fallback for local dev (wrangler dev has per-worker KV isolation)
  [key: string]: unknown;
}

/**
 * Resolve worker URL: KV registry first, then env var fallback.
 * Env var convention: {DOC_TYPE_UPPER}_WORKER_URL
 */
async function resolveWorkerUrl(env: Env, docType: string): Promise<string | null> {
  // 1. KV registry
  const entry = await env.REGISTRY.get<RegistryEntry>(`docType:${docType}`, "json");
  if (entry) return entry.workerUrl;

  // 2. Env var fallback (for local dev)
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

    // Must be: /users/{userId}/{docType}/...
    if (parts.length < 3 || parts[0] !== "users") {
      return Response.json({
        error: "Use /users/{userId}/{docType}/* endpoints",
      }, { status: 404 });
    }

    const userId = parts[1];
    const docType = parts[2];
    const docId = parts[3]; // may be undefined
    const method = parts[4]; // may be undefined

    // Look up worker URL from registry (KV + env var fallback)
    const workerUrl = await resolveWorkerUrl(env, docType);
    if (!workerUrl) {
      return Response.json({
        error: `Unknown document type: ${docType}`,
      }, { status: 404 });
    }

    // Route: list vs forward
    if (!docId) {
      if (request.method === "POST") {
        return forwardToWorker(request, workerUrl, userId, docType, env);
      }
      if (request.method === "GET") {
        return listDocuments(env, userId, docType);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Forward single-document request
    if (method && (EDITOR_METHODS.has(method) || OPERATOR_METHODS.has(method))) {
      return forwardToWorker(request, workerUrl, userId, docType, env);
    }

    return Response.json({
      error: `Unknown endpoint: ${method}`,
    }, { status: 404 });
  },
};

/**
 * Forward request to document type worker.
 * Strips the /{docType} segment from the path:
 *   Gateway:  /users/{userId}/markdown/{docId}/apply
 *   Worker:   /users/{userId}/{docId}/apply
 */
async function forwardToWorker(
  request: Request,
  workerUrl: string,
  userId: string,
  docType: string,
  env: Env,
): Promise<Response> {
  const originalUrl = new URL(request.url);
  const parts = originalUrl.pathname.split("/").filter(Boolean);
  // parts = ["users", userId, docType, docId, method, ...]
  // Build: /users/{userId}/{docId}/{method}/...
  const targetPath = [parts[0], parts[1], ...parts.slice(3)].join("/");
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

/**
 * List documents for a user from the shared D1 global index.
 */
async function listDocuments(
  env: Env,
  userId: string,
  docType: string,
): Promise<Response> {
  await env.SNAPSHOTS_DB.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      doc_id TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (doc_id, doc_type)
    )
  `);

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
