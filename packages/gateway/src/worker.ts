/**
 * UniDocs API Gateway
 *
 * Routes requests to document type Editor/Operator DOs.
 * Auth is handled here (future), DOs trust authenticated requests.
 *
 * API pattern:
 *   POST /{docType}/                          → create document (multipart, or clone with sourceId)
 *   GET  /{docType}/{docId}/export            → download document
 *   POST /{docType}/{docId}/query             → query document
 *   POST /{docType}/{docId}/apply             → apply delta
 *   POST /{docType}/{docId}/run               → operator ReAct loop
 *   GET  /{docType}/{docId}/history           → get delta history
 *   POST /{docType}/{docId}/rollback          → rollback to version
 *   POST /{docType}/{docId}/reset             → reset operator session
 *
 * Clone flow (POST /{docType}/ with sourceId):
 *   1. Gateway calls source editor's /snapshot to get current hash
 *   2. Gateway creates new editor DO
 *   3. Gateway calls new editor's /init_from_hash with the hash
 *   4. R2 CAS ensures no duplicate storage
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

      // Check if this is a clone request
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("multipart/form-data")) {
        // Parse form data to check for sourceId
        const formData = await request.formData();
        const sourceId = formData.get("sourceId") as string | null;
        const sourceVersion = formData.get("version") as string | null;

        if (sourceId) {
          // Clone flow:
          // 1. Get snapshot hash from source document
          const sourceStub = editorNs.get(editorNs.idFromName(sourceId));
          const snapshotUrl = new URL(request.url);
          snapshotUrl.pathname = "/_internal/snapshot";
          const snapshotHeaders = new Headers();
          snapshotHeaders.set("X-Doc-Type", docType);
          snapshotHeaders.set("X-Doc-Id", sourceId);
          
          const snapshotResp = await sourceStub.fetch(new Request(snapshotUrl.toString(), {
            method: "GET",
            headers: snapshotHeaders,
          }));

          if (!snapshotResp.ok) {
            const err = await snapshotResp.json() as { error?: string };
            return Response.json({ error: `Failed to get source snapshot: ${err.error || "unknown error"}` }, { status: 404 });
          }

          const snapshotData = await snapshotResp.json() as { hash: string; version: number };
          
          // If specific version requested, we need to handle that
          // For now, we only support cloning from current version
          if (sourceVersion && parseInt(sourceVersion) !== snapshotData.version) {
            return Response.json(
              { error: "Cloning from specific version not yet supported, only current version" },
              { status: 501 }
            );
          }

          // 2. Create new document from hash
          const newId = editorNs.newUniqueId();
          const newStub = editorNs.get(newId);
          const initUrl = new URL(request.url);
          initUrl.pathname = "/_internal/init_from_hash";
          const initHeaders = new Headers();
          initHeaders.set("X-Doc-Type", docType);
          initHeaders.set("X-Doc-Id", newId.toString());
          initHeaders.set("Content-Type", "application/json");

          return newStub.fetch(new Request(initUrl.toString(), {
            method: "POST",
            headers: initHeaders,
            body: JSON.stringify({ hash: snapshotData.hash, sourceVersion: snapshotData.version }),
          }));
        }
      }

      // Normal create flow
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
    if (["export", "query", "apply", "history", "rollback", "snapshot", "init_from_hash"].includes(method)) {
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
