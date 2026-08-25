/**
 * Shared HTTP routing for doc-type Cloudflare Workers (cloudflare-markdown,
 * cloudflare-docx, ...).
 *
 * Internal URL pattern:
 *   PUT  /sessions/{sessionId}                 → create session idempotently
 *   POST /sessions/{sessionId}/apply
 *   POST /sessions/{sessionId}/query
 *   GET  /sessions/{sessionId}/export
 *   GET  /sessions/{sessionId}/history
 *   POST /sessions/{sessionId}/rollback
 *   GET  /sessions/{sessionId}/snapshot
 *   GET  /sessions/{sessionId}/ir
 *   POST /sessions/{sessionId}/init-from-hash
 *   GET  /sessions/{sessionId}/status
 *   POST /sessions/{sessionId}/run
 *   POST /sessions/{sessionId}/reset
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
  accessKey: string;
  editor: DoNamespaceLike;
  operator: DoNamespaceLike;
}

const EDITOR_METHODS = new Map([
  ["query", "query"],
  ["apply", "apply"],
  ["history", "history"],
  ["rollback", "rollback"],
  ["export", "export"],
  ["snapshot", "snapshot"],
  ["ir", "ir"],
  ["init-from-hash", "init_from_hash"],
  ["status", "status"],
]);
const OPERATOR_METHODS = new Set(["run", "reset"]);

export function createDocTypeHandler(
  cfg: DocTypeHandlerConfig,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    // Verify internal token
    const token = request.headers.get("X-Internal-Token");
    if (!cfg.accessKey || token !== cfg.accessKey) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!request.headers.get("X-Tenant-Id")) {
      return Response.json({ error: "Missing X-Tenant-Id header" }, { status: 401 });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Expected: ["sessions", sessionId, method?]
    if (parts.length < 2 || parts[0] !== "sessions") {
      return Response.json({
        error: "Use /sessions/{sessionId}/* endpoints",
      }, { status: 404 });
    }

    const sessionId = parts[1];
    const method = parts[2];

    if (!method && request.method === "PUT") {
      const id = cfg.editor.idFromName(sessionId);
      const stub = cfg.editor.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/_internal/create";
      const headers = internalHeaders(request, cfg.docType, sessionId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: "POST",
        headers,
        body: request.body,
        duplex: "half",
      } as RequestInit));
    }

    if (!method) {
      return Response.json({ error: "Missing session method" }, { status: 400 });
    }

    const editorMethod = EDITOR_METHODS.get(method);
    if (editorMethod) {
      const id = cfg.editor.idFromName(sessionId);
      const stub = cfg.editor.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${editorMethod}`;
      const headers = internalHeaders(request, cfg.docType, sessionId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
        duplex: "half",
      } as RequestInit));
    }

    // Operator endpoints
    if (OPERATOR_METHODS.has(method)) {
      const id = cfg.operator.idFromName(sessionId);
      const stub = cfg.operator.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = internalHeaders(request, cfg.docType, sessionId);
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

function internalHeaders(request: Request, docType: string, sessionId: string): Headers {
  const headers = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Accept", "X-Internal-Token", "X-Tenant-Id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("X-Doc-Type", docType);
  headers.set("X-Session-Id", sessionId);
  return headers;
}
