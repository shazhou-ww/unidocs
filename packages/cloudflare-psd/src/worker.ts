/**
 * Cloudflare Worker entry point for the PSD image document type.
 *
 * Exports two Durable Object classes (PsdEditor, PsdOperator) that the
 * Gateway forwards to via HTTP. Mirrors the markdown adapter; see the
 * markdown worker for the full URL contract.
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/cloudflare-sdk";
import { createPsdDocumentType } from "@unidocs/doctype-psd";

const psd = createPsdDocumentType({});

export const PsdEditor = createEditorDO(psd);
export const PsdOperator = createOperatorDO({
  ...psd,
  llmProvider: async () => {
    throw new Error("LLM provider not configured. Set env.LLM_PROVIDER_URL and env.LLM_API_KEY.");
  },
  getEditorStub: () => {
    throw new Error("Editor stub factory not configured.");
  },
});

interface Env extends EditorEnv {
  PSD_EDITOR: DurableObjectNamespace;
  PSD_OPERATOR: DurableObjectNamespace;
  INTERNAL_TOKEN: string;
}

const EDITOR_METHODS = new Set([
  "query", "apply", "history", "rollback", "export",
  "snapshot", "init_from_hash",
]);
const OPERATOR_METHODS = new Set(["run", "reset"]);

const DOC_TYPE = "psd";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = request.headers.get("X-Internal-Token");
    if (env.INTERNAL_TOKEN && token !== env.INTERNAL_TOKEN) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Expected: ["users", userId, docId?, method?]
    if (parts.length < 2 || parts[0] !== "users") {
      return Response.json({ error: "Use /users/{userId}/{docId}/* endpoints" }, { status: 404 });
    }

    const userId = parts[1];
    const docId = parts[2];
    const method = parts[3];

    // POST /users/{userId}/ — create new document
    if (!docId && request.method === "POST") {
      const newDocId = request.headers.get("X-Doc-Id") || crypto.randomUUID();
      const id = env.PSD_EDITOR.idFromName(`${userId}:${newDocId}`);
      const stub = env.PSD_EDITOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/_internal/create";
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", DOC_TYPE);
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

    const forward = (ns: DurableObjectNamespace) => {
      const id = ns.idFromName(`${userId}:${docId}`);
      const stub = ns.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", DOC_TYPE);
      headers.set("X-User-Id", userId);
      headers.set("X-Doc-Id", docId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    };

    if (EDITOR_METHODS.has(method)) return forward(env.PSD_EDITOR);
    if (OPERATOR_METHODS.has(method)) return forward(env.PSD_OPERATOR);

    return Response.json({ error: `Unknown endpoint: ${method}` }, { status: 404 });
  },
};
