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
 * Env vars: DATABASE_URL, INTERNAL_TOKEN, PORT, plus one of two blob configs:
 * in the cloud BLOB_ACCOUNT_URL + AZURE_CLIENT_ID (user-assigned managed
 * identity; without the latter the container starts and passes health checks,
 * then fails on the first blob operation — which is why resolveBlobConfig()
 * makes it a startup-time requirement), locally/Azurite BLOB_CONNECTION_STRING.
 * CAS_BASE_URL is optional (transitional, see doc-type-service.ts).
 *
 * CAS_BASE_URL's INTERNAL_TOKEN must match the Cloudflare CAS worker's: that
 * worker 401s every request whose X-Internal-Token differs.
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
