/**
 * Cloudflare Worker entry point for Markdown document type.
 *
 * Exports two Durable Object classes (MarkdownEditor, MarkdownOperator)
 * that the Gateway forwards to via HTTP.
 *
 * Internal URL pattern: /sessions/{sessionId}/*.
 *
 * Auth: verifies request-local capabilities from Gateway.
 */

import {
  createEditorDO,
  createOperatorDO,
  type EditorEnv,
} from "@unidocs/cloudflare-sdk";
import {
  createMarkdownDocumentType,
  markdownAgent,
} from "@unidocs/doctype-markdown";
import {
  createDocTypeHandler,
  DocAuthConfigCache,
  type DocAuthBindings,
} from "@unidocs/doctype-server-common";

import { markdownDiscovery, markdownApiRequest, type MarkdownDiscoveryBindings } from "./discovery.js";
import { markdownOperatorEndpoint } from "./operator-endpoint.js";
import { markdownOperatorWebhook, type MarkdownOperatorWebhookBindings } from "./operator-webhook.js";

const markdownFactory = createMarkdownDocumentType;
const authConfig = new DocAuthConfigCache("markdown");

// Generate Editor and Operator Durable Objects from the markdown DocumentType
export const MarkdownEditor = createEditorDO(markdownFactory);
export const MarkdownOperator = createOperatorDO({
  agent: markdownAgent,
  // Placeholder, unchanged in meaning: this worker has no model configured,
  // so the first /run fails with a clear message instead of at boot.
  provider: () => ({
    complete: async () => {
      throw new Error("LLM provider not configured. Set LLM_API_KEY in this worker's env.");
    },
  }),
  getEditorStub: (env: Env, sessionId) => {
    const id = env.MARKDOWN_EDITOR.idFromName(sessionId);
    return env.MARKDOWN_EDITOR.get(id);
  },
});

interface Env extends EditorEnv, DocAuthBindings, MarkdownDiscoveryBindings, MarkdownOperatorWebhookBindings {
  MARKDOWN_EDITOR: DurableObjectNamespace;
  MARKDOWN_OPERATOR: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    const operatorWebhook = await markdownOperatorWebhook(request, env, context);
    if (operatorWebhook) return operatorWebhook;
    const operatorEndpoint = await markdownOperatorEndpoint(request, env);
    if (operatorEndpoint) return operatorEndpoint;
    const discovery = markdownDiscovery(request, env);
    if (discovery) return discovery;
    return createDocTypeHandler({
      docType: "markdown",
      ...(await authConfig.get(env)),
      audit: event => console.log(JSON.stringify({ event: "doc_authentication", docType: "markdown", ...event })),
      editor: env.MARKDOWN_EDITOR,
      operator: env.MARKDOWN_OPERATOR,
    })(markdownApiRequest(request));
  },
};
