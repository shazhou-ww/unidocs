/**
 * Cloudflare Worker entry point for the PSD image document type.
 *
 * Exports two Durable Object classes (PsdEditor, PsdOperator) that the Gateway
 * forwards to via HTTP. Routing (path parsing, method dispatch, header
 * injection) is inline here, mirroring the docx/markdown workers — see the
 * docx worker for the URL contract.
 *
 * The operator (chatbox agent) runs the PSD tool set from @unidocs/doctype-psd
 * against Claude via the Anthropic provider in
 * @unidocs/doctype-server-common/agent. Credentials come from env
 * (LLM_API_KEY / LLM_BASE_URL / LLM_MODEL, or the ANTHROPIC_* aliases): in
 * production from wrangler secrets, in local dev from
 * packages/cloudflare-psd/.dev.vars — `readDevVars` in
 * stacks/unidocs-cloudflare/local/runtime.mjs parses it and `buildWorkers` merges it into this
 * worker's Miniflare bindings.
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/cloudflare-sdk";
import { createPsdDocumentType, createPsdAgent } from "@unidocs/doctype-psd";
import {
  createDocTypeHandler,
  DocAuthConfigCache,
  type DocAuthBindings,
} from "@unidocs/doctype-server-common";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";

const psdFactory = createPsdDocumentType;
const authConfig = new DocAuthConfigCache("psd");

export const PsdEditor = createEditorDO(psdFactory);
export const PsdOperator = createOperatorDO({
  agent: createPsdAgent({}),   // Task 8 换成按 env 注入 editor 的工厂
  // The provider is built from env: a DO instance outlives a config change,
  // and `env` is only handed to us here.
  provider: (env: Env) => createAnthropicProvider(env),
  getEditorStub: (env: Env, sessionId) => {
    const id = env.PSD_EDITOR.idFromName(sessionId);
    return env.PSD_EDITOR.get(id);
  },
  // A PSD edit is inherently multi-step — find the layer, preview it,
  // transform it, preview again to check — so the platform default (10) cuts
  // real instructions off mid-edit.
  maxIterations: 25,
});

interface Env extends EditorEnv, DocAuthBindings {
  PSD_EDITOR: DurableObjectNamespace;
  PSD_OPERATOR: DurableObjectNamespace;
  // Operator LLM config — see the Anthropic provider in
  // @unidocs/doctype-server-common/agent and .dev.vars.example.
  // Absent in deployments that never run the chatbox; the provider throws a
  // clear error on the first /run instead of at construction time.
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createDocTypeHandler({
      docType: "psd",
      ...(await authConfig.get(env)),
      audit: event => console.log(JSON.stringify({ event: "doc_authentication", docType: "psd", ...event })),
      editor: env.PSD_EDITOR,
      operator: env.PSD_OPERATOR,
    })(request);
  },
};
