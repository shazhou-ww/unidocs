/**
 * Shared HTTP routing for doc-type Cloudflare Workers (cloudflare-markdown,
 * cloudflare-docx, ...).
 *
 * URL pattern (called by Gateway after stripping /{docType}):
 *   POST /users/{userId}/                             → create document
 *   POST /users/{userId}/{docId}/apply                → apply delta
 *   POST /users/{userId}/{docId}/query                → query document
 *   GET  /users/{userId}/{docId}/export               → download document
 *   GET  /users/{userId}/{docId}/history              → get delta history
 *   POST /users/{userId}/{docId}/rollback             → rollback to version
 *   GET  /users/{userId}/{docId}/snapshot             → get snapshot hash (for clone)
 *   POST /users/{userId}/{docId}/init_from_hash       → clone from snapshot
 *   POST /users/{userId}/{docId}/run                  → operator ReAct loop
 *   POST /users/{userId}/{docId}/reset                → reset operator session
 *
 * Auth: verifies X-Internal-Token from Gateway.
 */

/**
 * Structural view of a Durable Object namespace binding. Deliberately not
 * `DurableObjectNamespace` — server-core stays cloud-neutral (no Cloudflare
 * imports), and Cloudflare's real namespace type is structurally compatible
 * with this shape.
 */
interface DoNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

export interface DocTypeHandlerConfig {
  docType: string;
  internalToken: string;
  editor: DoNamespaceLike;
  operator: DoNamespaceLike;
}

const EDITOR_METHODS = new Set([
  "query", "apply", "history", "rollback", "export",
  "snapshot", "init_from_hash",
]);
const OPERATOR_METHODS = new Set(["run", "reset"]);

export function createDocTypeHandler(
  cfg: DocTypeHandlerConfig,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    // Verify internal token
    const token = request.headers.get("X-Internal-Token");
    if (cfg.internalToken && token !== cfg.internalToken) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Expected: ["users", userId, docId?, method?]
    if (parts.length < 2 || parts[0] !== "users") {
      return Response.json({
        error: "Use /users/{userId}/{docId}/* endpoints",
      }, { status: 404 });
    }

    const userId = parts[1];
    const docId = parts[2];
    const method = parts[3];

    // POST /users/{userId}/ — create new document
    if (!docId && request.method === "POST") {
      const newDocId = request.headers.get("X-Doc-Id") || crypto.randomUUID();
      const id = cfg.editor.idFromName(`${userId}:${newDocId}`);
      const stub = cfg.editor.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/_internal/create";
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", cfg.docType);
      headers.set("X-Doc-Id", newDocId);
      headers.set("X-User-Id", userId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: "POST",
        headers,
        body: request.body,
        duplex: "half",
      } as RequestInit));
    }

    if (!docId || !method) {
      return Response.json({ error: "Missing docId or method" }, { status: 400 });
    }

    // Editor endpoints
    if (EDITOR_METHODS.has(method)) {
      const id = cfg.editor.idFromName(`${userId}:${docId}`);
      const stub = cfg.editor.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", cfg.docType);
      headers.set("X-User-Id", userId);
      headers.set("X-Doc-Id", docId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
      } as RequestInit));
    }

    // Operator endpoints
    if (OPERATOR_METHODS.has(method)) {
      const id = cfg.operator.idFromName(`${userId}:${docId}`);
      const stub = cfg.operator.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", cfg.docType);
      headers.set("X-User-Id", userId);
      headers.set("X-Doc-Id", docId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
      } as RequestInit));
    }

    return Response.json({ error: `Unknown endpoint: ${method}` }, { status: 404 });
  };
}
