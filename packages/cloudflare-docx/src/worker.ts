/**
 * Cloudflare Worker entry point for DOCX document type.
 *
 * Exports two Durable Object classes (DocxEditor, DocxOperator)
 * that the Gateway forwards to via HTTP.
 *
 * Routing (path parsing, method dispatch, header injection) lives in
 * @unidocs/server-core's createDocTypeHandler — see that file for the URL
 * pattern and auth details.
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/cloudflare-sdk";
import { createDocxDocumentType } from "@unidocs/doctype-docx";
import { createDocTypeHandler } from "@unidocs/server-core";

const docx = createDocxDocumentType({});

// Generate Editor and Operator Durable Objects from the docx DocumentType
export const DocxEditor = createEditorDO(docx);
export const DocxOperator = createOperatorDO({
  ...docx,
  llmProvider: async () => {
    throw new Error("LLM provider not configured. Set env.LLM_PROVIDER_URL and env.LLM_API_KEY.");
  },
  getEditorStub: () => {
    throw new Error("Editor stub factory not configured.");
  },
});

interface Env extends EditorEnv {
  DOCX_EDITOR: DurableObjectNamespace;
  DOCX_OPERATOR: DurableObjectNamespace;
  INTERNAL_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createDocTypeHandler({
      docType: "docx",
      internalToken: env.INTERNAL_TOKEN,
      editor: env.DOCX_EDITOR,
      operator: env.DOCX_OPERATOR,
    })(request);
  },
};
