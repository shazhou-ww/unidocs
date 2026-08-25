/**
 * Cloudflare Worker entry point for the PSD image document type.
 *
 * Exports two Durable Object classes (PsdEditor, PsdOperator) that the Gateway
 * forwards to via HTTP. Routing (path parsing, method dispatch, header
 * injection) is inline here, mirroring the docx/markdown workers — see the
 * docx worker for the URL contract.
 *
 * NOTE: the PSD operator (chat/agent) is a stub here. The render engine +
 * editor path (create/query/apply/export/rollback/snapshot) is fully wired;
 * the chatbox needs the platform to pass env to operators (follow-up).
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/cloudflare-sdk";
import { createPsdDocumentType } from "@unidocs/doctype-psd";
import { createDocTypeHandler } from "@unidocs/doctype-server-common";

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
  getEditorStub: (env: Env, sessionId) => {
    const id = env.PSD_EDITOR.idFromName(sessionId);
    return env.PSD_EDITOR.get(id);
  },
});

interface Env extends EditorEnv {
  PSD_EDITOR: DurableObjectNamespace;
  PSD_OPERATOR: DurableObjectNamespace;
  SERVICE_ACCESS_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createDocTypeHandler({
      docType: "psd",
      accessKey: env.SERVICE_ACCESS_KEY,
      editor: env.PSD_EDITOR,
      operator: env.PSD_OPERATOR,
    })(request);
  },
};
