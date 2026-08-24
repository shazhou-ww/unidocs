/**
 * Cloudflare Worker entry point for the PSD image document type.
 *
 * Exports two Durable Object classes (PsdEditor, PsdOperator) that the Gateway
 * forwards to via HTTP. Routing (path parsing, method dispatch, header
 * injection) lives in @unidocs/server-core's createDocTypeHandler — see the
 * markdown worker for the URL contract.
 *
 * NOTE: the PSD operator (chat/agent) is a stub here. The render engine +
 * editor path (create/query/apply/export/rollback/snapshot) is fully wired;
 * the chatbox needs the platform to pass env to operators (follow-up).
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/cloudflare-sdk";
import { createPsdDocumentType } from "@unidocs/doctype-psd";
import { createDocTypeHandler } from "@unidocs/server-core";

const psdFactory = createPsdDocumentType;

export const PsdEditor = createEditorDO(psdFactory);
export const PsdOperator = createOperatorDO({
  agentFactory: (_ctx) => ({
    tools: {},
    instructions: "PSD operator is a stub. Agent support requires threading env into createOperatorDO.",
    toolCall: async () => ({ content: [{ type: "text" as const, text: "PSD operator not implemented" }] }),
  }),
  llmProvider: async () => {
    throw new Error(
      "PSD operator LLM provider not configured. See ./anthropic.ts for the intended provider.",
    );
  },
  getEditorStub: (env: Env, userId, docId) => {
    const id = env.PSD_EDITOR.idFromName(`${userId}:${docId}`);
    return env.PSD_EDITOR.get(id);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = request.headers.get("X-Internal-Token");
    if (env.INTERNAL_TOKEN && token !== env.INTERNAL_TOKEN) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 2 || parts[0] !== "users") {
      return Response.json({
        error: "Use /users/{userId}/{docId}/* endpoints",
      }, { status: 404 });
    }

    const userId = parts[1];
    const docId = parts[2];
    const method = parts[3];

    if (!docId && request.method === "POST") {
      const newDocId = request.headers.get("X-Doc-Id") || crypto.randomUUID();
      const id = env.PSD_EDITOR.idFromName(`${userId}:${newDocId}`);
      const stub = env.PSD_EDITOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = "/_internal/create";
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", "psd");
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

    if (EDITOR_METHODS.has(method)) {
      const id = env.PSD_EDITOR.idFromName(`${userId}:${docId}`);
      const stub = env.PSD_EDITOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", "psd");
      headers.set("X-User-Id", userId);
      headers.set("X-Doc-Id", docId);
      return stub.fetch(new Request(forwardUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
      }));
    }

    if (OPERATOR_METHODS.has(method)) {
      const id = env.PSD_OPERATOR.idFromName(`${userId}:${docId}`);
      const stub = env.PSD_OPERATOR.get(id);
      const forwardUrl = new URL(request.url);
      forwardUrl.pathname = `/_internal/${method}`;
      const headers = new Headers(request.headers);
      headers.set("X-Doc-Type", "psd");
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
