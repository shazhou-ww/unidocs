/**
 * Cloudflare Worker entry point for Markdown document type.
 *
 * This worker exports two Durable Object classes (MarkdownEditor, MarkdownOperator)
 * that are referenced by the Gateway worker via cross-script bindings.
 *
 * It also exposes a direct fetch handler for standalone testing,
 * routing requests to the appropriate DO based on path.
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/sdk";
import { markdown } from "./markdown.js";

// Generate Editor and Operator Durable Objects from the markdown DocumentType
export const MarkdownEditor = createEditorDO(markdown);
export const MarkdownOperator = createOperatorDO({
  ...markdown,
  // LLM provider and editor stub factory — injected via env bindings at runtime
  llmProvider: async (messages, tools) => {
    throw new Error("LLM provider not configured. Set env.LLM_PROVIDER_URL and env.LLM_API_KEY.");
  },
  getEditorStub: (docId: string) => {
    throw new Error("Editor stub factory not configured.");
  },
});

interface Env extends EditorEnv {
  MARKDOWN_EDITOR: DurableObjectNamespace;
  MARKDOWN_OPERATOR: DurableObjectNamespace;
}

// Standalone fetch handler (for direct testing without Gateway)
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // /create — create new document
    if (parts.length === 0 && request.method === "POST") {
      const id = env.MARKDOWN_EDITOR.newUniqueId();
      const stub = env.MARKDOWN_EDITOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/_internal/create";
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", "markdown");
      headers.set("X-Doc-Id", id.toString());
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    }

    const docId = parts[0];
    const method = parts[1];

    if (!docId) {
      return new Response("Use /{docId}/* endpoints", { status: 404 });
    }

    // Editor endpoints
    if (["query", "apply", "history", "rollback", "export", "snapshot", "init_from_hash"].includes(method)) {
      const id = env.MARKDOWN_EDITOR.idFromName(docId);
      const stub = env.MARKDOWN_EDITOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", "markdown");
      headers.set("X-Doc-Id", docId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    }

    // Operator endpoints
    if (["run", "reset"].includes(method)) {
      const id = env.MARKDOWN_OPERATOR.idFromName(docId);
      const stub = env.MARKDOWN_OPERATOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }));
    }

    return Response.json({ error: `Unknown endpoint: ${method}` }, { status: 404 });
  },
};
