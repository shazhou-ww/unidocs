/**
 * Cloudflare Worker entry point for Markdown document type.
 *
 * Exports two Durable Object classes (MarkdownEditor, MarkdownOperator)
 * that the Gateway forwards to via HTTP.
 *
 * Routing (path parsing, method dispatch, header injection) lives in
 * @unidocs/server-core's createDocTypeHandler — see that file for the URL
 * pattern and auth details.
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/cloudflare-sdk";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";
import { createDocTypeHandler } from "@unidocs/server-core";

const markdown = createMarkdownDocumentType({});

// Generate Editor and Operator Durable Objects from the markdown DocumentType
export const MarkdownEditor = createEditorDO(markdown);
export const MarkdownOperator = createOperatorDO({
  ...markdown,
  llmProvider: async () => {
    throw new Error("LLM provider not configured. Set env.LLM_PROVIDER_URL and env.LLM_API_KEY.");
  },
  getEditorStub: () => {
    throw new Error("Editor stub factory not configured.");
  },
});

interface Env extends EditorEnv {
  MARKDOWN_EDITOR: DurableObjectNamespace;
  MARKDOWN_OPERATOR: DurableObjectNamespace;
  INTERNAL_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createDocTypeHandler({
      docType: "markdown",
      internalToken: env.INTERNAL_TOKEN,
      editor: env.MARKDOWN_EDITOR,
      operator: env.MARKDOWN_OPERATOR,
    })(request);
  },
};
