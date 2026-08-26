/**
 * Cloudflare Worker entry point for Markdown document type.
 *
 * Exports two Durable Object classes (MarkdownEditor, MarkdownOperator)
 * that the Gateway forwards to via HTTP.
 *
 * Internal URL pattern: /sessions/{sessionId}/*.
 *
 * Auth: verifies X-Internal-Token from Gateway.
 */

import {
  createEditorDO,
  createOperatorDO,
  type EditorEnv,
} from "@unidocs/cloudflare-sdk";
import {
  createMarkdownDocumentAgent,
  createMarkdownDocumentType,
} from "@unidocs/doctype-markdown";
import {
  createDocTypeHandler,
  DocAuthConfigCache,
  type DocAuthBindings,
} from "@unidocs/doctype-server-common";

const markdownFactory = createMarkdownDocumentType;
const authConfig = new DocAuthConfigCache("markdown");

// Generate Editor and Operator Durable Objects from the markdown DocumentType
export const MarkdownEditor = createEditorDO(markdownFactory);
export const MarkdownOperator = createOperatorDO({
  agentFactory: createMarkdownDocumentAgent,
  llmProvider: async () => {
    throw new Error("LLM provider not configured. Set env.LLM_PROVIDER_URL and env.LLM_API_KEY.");
  },
  getEditorStub: (env: Env, sessionId) => {
    const id = env.MARKDOWN_EDITOR.idFromName(sessionId);
    return env.MARKDOWN_EDITOR.get(id);
  },
});

interface Env extends EditorEnv, DocAuthBindings {
  MARKDOWN_EDITOR: DurableObjectNamespace;
  MARKDOWN_OPERATOR: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createDocTypeHandler({
      docType: "markdown",
      ...authConfig.get(env),
      audit: event => console.log(JSON.stringify({ event: "doc_authentication", docType: "markdown", ...event })),
      editor: env.MARKDOWN_EDITOR,
      operator: env.MARKDOWN_OPERATOR,
    })(request);
  },
};
