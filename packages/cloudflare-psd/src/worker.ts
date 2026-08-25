/**
 * Cloudflare Worker entry point for the PSD image document type.
 *
 * Exports two Durable Object classes (PsdEditor, PsdOperator) that the Gateway
 * forwards to via HTTP. Routing (path parsing, method dispatch, header
 * injection) is inline here, mirroring the docx/markdown workers — see the
 * docx worker for the URL contract.
 *
 * The operator (chatbox agent) runs the PSD tool set from @unidocs/doctype-psd
 * against Claude via ./anthropic.ts. Credentials come from env
 * (LLM_API_KEY / LLM_BASE_URL / LLM_MODEL, or the ANTHROPIC_* aliases): in
 * production from wrangler secrets, in local dev from
 * packages/cloudflare-psd/.dev.vars — `readDevVars` in
 * scripts/local-runtime.mjs parses it and `buildWorkers` merges it into this
 * worker's Miniflare bindings.
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/cloudflare-sdk";
import { createPsdDocumentAgent, createPsdDocumentType } from "@unidocs/doctype-psd";
import { createAnthropicLlmProvider } from "./anthropic.js";

const psdFactory = createPsdDocumentType;

export const PsdEditor = createEditorDO(psdFactory);
export const PsdOperator = createOperatorDO({
  agentFactory: createPsdDocumentAgent,
  // The provider is bound per call: a DO instance outlives a config change,
  // and `env` is only handed to us here.
  llmProvider: (messages, tools, env: Env) =>
    createAnthropicLlmProvider(env)(messages, tools),
  getEditorStub: (env: Env, userId, docId) => {
    const id = env.PSD_EDITOR.idFromName(`${userId}:${docId}`);
    return env.PSD_EDITOR.get(id);
  },
});

interface Env extends EditorEnv {
  PSD_EDITOR: DurableObjectNamespace;
  PSD_OPERATOR: DurableObjectNamespace;
  INTERNAL_TOKEN: string;
  // Operator LLM config — see ./anthropic.ts and .dev.vars.example.
  // Absent in deployments that never run the chatbox; the provider throws a
  // clear error on the first /run instead of at construction time.
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

const EDITOR_METHODS = new Set([
  "query", "apply", "history", "rollback", "export",
  "snapshot", "ir", "init_from_hash",
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
