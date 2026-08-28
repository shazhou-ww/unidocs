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
  createDocxDocumentType,
  docxAgent,
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
  agent: docxAgent,
  // Placeholder, unchanged in meaning: this worker has no model configured,
  // so the first /run fails with a clear message instead of at boot.
  provider: () => ({
    complete: async () => {
      throw new Error("LLM provider not configured. Set LLM_API_KEY in this worker's env.");
    },
  }),
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
      audit: event => console.log(JSON.stringify({ event: "doc_authentication", docType: "docx", ...event })),
      editor: env.DOCX_EDITOR,
      operator: env.DOCX_OPERATOR,
    })(request);
  },
};
