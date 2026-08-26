/**
 * Cloudflare Worker entry point for DOCX document type.
 *
 * Exports two Durable Object classes (DocxEditor, DocxOperator)
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
  createDocxDocumentAgent,
  createDocxDocumentType,
} from "@unidocs/doctype-docx";
import {
  createDocTypeHandler,
  DocAuthConfigCache,
  type DocAuthBindings,
} from "@unidocs/doctype-server-common";

const docxFactory = createDocxDocumentType;
const authConfig = new DocAuthConfigCache("docx");

// Generate Editor and Operator Durable Objects from the docx DocumentType
export const DocxEditor = createEditorDO(docxFactory);
export const DocxOperator = createOperatorDO({
  agentFactory: createDocxDocumentAgent,
  llmProvider: async () => {
    throw new Error("LLM provider not configured. Set env.LLM_PROVIDER_URL and env.LLM_API_KEY.");
  },
  getEditorStub: (env: Env, sessionId) => {
    const id = env.DOCX_EDITOR.idFromName(sessionId);
    return env.DOCX_EDITOR.get(id);
  },
});

interface Env extends EditorEnv, DocAuthBindings {
  DOCX_EDITOR: DurableObjectNamespace;
  DOCX_OPERATOR: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createDocTypeHandler({
      docType: "docx",
      ...authConfig.get(env),
      editor: env.DOCX_EDITOR,
      operator: env.DOCX_OPERATOR,
    })(request);
  },
};
