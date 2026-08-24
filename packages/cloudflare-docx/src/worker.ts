/**
 * Cloudflare Worker entry point for DOCX document type.
 *
 * Exports two Durable Object classes (DocxEditor, DocxOperator)
 * that the Gateway forwards to via HTTP.
 *
 * URL pattern (called by Gateway after stripping /{docType}):
 *   POST /users/{userId}/                             → create document
 *   POST /users/{userId}/{docId}/apply                → apply delta
 *   POST /users/{userId}/{docId}/query                → query document
 *   GET  /users/{userId}/{docId}/export               → download document
 *   GET  /users/{userId}/{docId}/history              → get delta history
 *   POST /users/{userId}/{docId}/rollback             → rollback to version
 *   GET  /users/{userId}/{docId}/snapshot             → get snapshot hash (for clone)
 *   GET  /users/{userId}/{docId}/ir                   → get canonical current-TDoc bytes
 *   POST /users/{userId}/{docId}/init_from_hash       → clone from snapshot
 *   POST /users/{userId}/{docId}/run                  → operator ReAct loop
 *   POST /users/{userId}/{docId}/reset                → reset operator session
 *
 * Auth: verifies X-Internal-Token from Gateway.
 */

import {
  createEditorDO,
  createOperatorDO,
  type EditorEnv,
} from "@unidocs/cloudflare-sdk";
import {
  createDocxDocumentAgent,
  createDocxDocumentType,
} from "@unidocs/doctype-docx";

const docxFactory = createDocxDocumentType;

// Generate Editor and Operator Durable Objects from the docx DocumentType
export const DocxEditor = createEditorDO(docxFactory);
export const DocxOperator = createOperatorDO({
  agentFactory: createDocxDocumentAgent,
  llmProvider: async () => {
    throw new Error("LLM provider not configured. Set env.LLM_PROVIDER_URL and env.LLM_API_KEY.");
  },
  getEditorStub: (env: Env, userId, docId) => {
    const id = env.DOCX_EDITOR.idFromName(`${userId}:${docId}`);
    return env.DOCX_EDITOR.get(id);
  },
});

interface Env extends EditorEnv {
  DOCX_EDITOR: DurableObjectNamespace;
  DOCX_OPERATOR: DurableObjectNamespace;
  INTERNAL_TOKEN: string;
}

const EDITOR_METHODS = new Set([
  "query", "apply", "history", "rollback", "export",
  "snapshot", "ir", "init_from_hash",
]);
const OPERATOR_METHODS = new Set(["run", "reset"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Verify internal token
    const token = request.headers.get("X-Internal-Token");
    if (env.INTERNAL_TOKEN && token !== env.INTERNAL_TOKEN) {
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
      const id = env.DOCX_EDITOR.idFromName(`${userId}:${newDocId}`);
      const stub = env.DOCX_EDITOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/_internal/create";
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", "docx");
      headers.set("X-Doc-Id", newDocId);
      headers.set("X-User-Id", userId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: "POST",
        headers,
        body: request.body,
      }));
    }

    if (!docId || !method) {
      return Response.json({ error: "Missing docId or method" }, { status: 400 });
    }

    // Editor endpoints
    if (EDITOR_METHODS.has(method)) {
      const id = env.DOCX_EDITOR.idFromName(`${userId}:${docId}`);
      const stub = env.DOCX_EDITOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", "docx");
      headers.set("X-User-Id", userId);
      headers.set("X-Doc-Id", docId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    }

    // Operator endpoints
    if (OPERATOR_METHODS.has(method)) {
      const id = env.DOCX_OPERATOR.idFromName(`${userId}:${docId}`);
      const stub = env.DOCX_OPERATOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", "docx");
      headers.set("X-User-Id", userId);
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
