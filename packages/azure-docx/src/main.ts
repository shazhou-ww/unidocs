/**
 * Azure/Node entry point for the DOCX document type.
 *
 * Same shape as `packages/azure-markdown/src/main.ts`, and deliberately
 * only that similar: everything except the doc type and the default port
 * lives in `@unidocs/azure-sdk`'s `runDocTypeService()` — connection pool
 * and its four timeouts, Blob client, port construction, per-request
 * DocumentSession, CAS wiring, graceful shutdown. If this file needs to
 * duplicate anything from the markdown entry beyond those two values, the
 * SDK extraction is incomplete — fix `azure-sdk`, don't copy here.
 *
 * DOCX's image path needs user-scoped CAS. This round is transitional:
 * CAS_BASE_URL points at the Cloudflare CAS worker (replaced by azure-cas
 * in phase 4).
 *
 * Env vars: DATABASE_URL, BLOB_CONNECTION_STRING, INTERNAL_TOKEN, PORT,
 * CAS_BASE_URL (optional, transitional, see doc-type-service.ts).
 */
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createDocxDocumentType } from "@unidocs/doctype-docx";

runDocTypeService({
  docType: "docx",
  documentType: createDocxDocumentType({}),
  defaultPort: 8789,
}).catch((err) => {
  console.error("azure-docx failed to start:", err);
  process.exit(1);
});
