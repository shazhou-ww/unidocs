/**
 * UniDocs API Gateway
 *
 * Routes requests to document type Editor/Operator DOs.
 * Auth is handled here (future), DOs trust authenticated requests.
 *
 * API pattern:
 *   POST /{docType}/                          → create document (multipart)
 *   GET  /{docType}/{docId}/export            → download document
 *   POST /{docType}/{docId}/query             → query document
 *   POST /{docType}/{docId}/apply             → apply delta
 *   POST /{docType}/{docId}/run               → operator ReAct loop
 *   GET  /{docType}/{docId}/history           → get delta history
 *   POST /{docType}/{docId}/rollback          → rollback to version
 *   POST /{docType}/{docId}/reset             → reset operator session
 */

interface Env {
  [key: string]: DurableObjectNamespace | string | undefined;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Must have at least /{docType}
    if (parts.length === 0) {
      return new Response("UniDocs API Gateway — use /{docType}/* endpoints", { status: 404 });
    }

    const docType = parts[0];
    const docId = parts[1]; // may be undefined for POST /{docType}/
    const method = parts[2]; // export | query | apply | run | history | rollback | reset

    // Resolve bindings by convention: {DOC_TYPE}_EDITOR / {DOC_TYPE}_OPERATOR
    const prefix = docType.toUpperCase();
    const editorNs = env[`${prefix}_EDITOR`] as DurableObjectNamespace | undefined;
    const operatorNs = env[`${prefix}_OPERATOR`] as DurableObjectNamespace | undefined;

    if (!editorNs && !operatorNs) {
      return Response.json({ error: `Unknown document type: ${docType}` }, { status: 404 });
    }

    // POST /{docType}/ — create new document (goes to Editor)
    if (!docId && request.method === "POST") {
      if (!editorNs) {
        return Response.json({ error: `Editor not available for: ${docType}` }, { status: 404 });
      }
      const id = editorNs.newUniqueId();
      const stub = editorNs.get(id);
      const createUrl = new URL(request.url);
      createUrl.pathname = "/_internal/create";
      // Pass docType and docId in headers
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", docType);
      headers.set("X-Doc-Id", id.toString());
      return stub.fetch(new Request(createUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    }

    if (!docId) {
      return Response.json({ error: "Missing docId" }, { status: 400 });
    }

    // Editor endpoints
    if (["export", "query", "apply", "history", "rollback"].includes(method)) {
      if (!editorNs) {
        return Response.json({ error: `Editor not available for: ${docType}` }, { status: 404 });
      }
      const id = editorNs.idFromName(docId);
      const stub = editorNs.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      // Pass context headers
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", docType);
      headers.set("X-Doc-Id", docId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    }

    // Operator endpoints
    if (["run", "reset"].includes(method)) {
      if (!operatorNs) {
        return Response.json({ error: `Operator not available for: ${docType}` }, { status: 404 });
      }
      const id = operatorNs.idFromName(docId);
      const stub = operatorNs.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", docType);
      headers.set("X-Doc-Id", docId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    }

    return Response.json({ error: `Unknown endpoint: ${method}` }, { status: 404 });
  },
};
