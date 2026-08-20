/**
 * Cloudflare Worker entry point for the PSD image document type.
 *
 * Exports two Durable Object classes (PsdEditor, PsdOperator) that the Gateway
 * forwards to via HTTP. Routing (path parsing, method dispatch, header
 * injection) lives in @unidocs/server-core's createDocTypeHandler — see the
 * markdown worker for the URL contract.
 *
 * NOTE: the PSD operator (chat/agent) is a stub here. main's createOperatorDO
 * does not thread `env` into its `llmProvider`/`getEditorStub` (its DO
 * constructor ignores env), so an env-based LLM provider — the Anthropic
 * provider in ./anthropic.ts — cannot be wired through it yet. This is the same
 * limitation main's own markdown/docx operators have. The render engine +
 * editor path (create/query/apply/export/rollback/snapshot) is fully wired;
 * the chatbox needs the platform to pass env to operators (follow-up).
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/cloudflare-sdk";
import { createPsdDocumentType } from "@unidocs/doctype-psd";
import { createDocTypeHandler } from "@unidocs/server-core";

const psd = createPsdDocumentType({});

export const PsdEditor = createEditorDO(psd);
export const PsdOperator = createOperatorDO({
  ...psd,
  llmProvider: async () => {
    throw new Error(
      "PSD operator LLM provider not configured: main's createOperatorDO does not pass env to llmProvider. See ./anthropic.ts for the intended provider.",
    );
  },
  getEditorStub: () => {
    throw new Error("PSD operator editor-stub factory not configured (needs env threading).");
  },
});

interface Env extends EditorEnv {
  PSD_EDITOR: DurableObjectNamespace;
  PSD_OPERATOR: DurableObjectNamespace;
  INTERNAL_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createDocTypeHandler({
      docType: "psd",
      internalToken: env.INTERNAL_TOKEN,
      editor: env.PSD_EDITOR,
      operator: env.PSD_OPERATOR,
    })(request);
  },
};
