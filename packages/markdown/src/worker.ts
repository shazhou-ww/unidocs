/**
 * Cloudflare Worker entry point for Markdown document type.
 */

import { createEditorDO, createOperatorDO } from "@unidocs/sdk";
import { markdown } from "./markdown.js";

// Generate Editor and Operator Durable Objects
export const MarkdownEditor = createEditorDO(markdown);
export const MarkdownOperator = createOperatorDO({
  ...markdown,
  // LLM provider and editor stub will be injected at runtime via env bindings
  llmProvider: async (messages, tools) => {
    // Placeholder — actual implementation reads from env.OPENAI_API_KEY or similar
    throw new Error("LLM provider not configured. Set env.LLM_PROVIDER_URL and env.LLM_API_KEY.");
  },
  editorStub: null as any, // Injected via env binding at runtime
});

// Worker entry point — routes requests to the appropriate DO
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const docId = url.searchParams.get("docId") || "default";

    if (url.pathname.startsWith("/editor")) {
      const editorId = env.MARKDOWN_EDITOR.idFromName(docId);
      const editorStub = env.MARKDOWN_EDITOR.get(editorId);
      return editorStub.fetch(request);
    }

    if (url.pathname.startsWith("/operator")) {
      const operatorId = env.MARKDOWN_OPERATOR.idFromName(docId);
      const operatorStub = env.MARKDOWN_OPERATOR.get(operatorId);
      return operatorStub.fetch(request);
    }

    return new Response("Use /editor/* or /operator/* endpoints", { status: 404 });
  },
};
