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
 * DOCX's image path needs tenant-scoped CAS. This round is transitional:
 * CAS_BASE_URL points at the Cloudflare CAS worker (replaced by azure-cas
 * in phase 4).
 *
 * Env vars: DATABASE_URL, CAS_STACK_ID, PORT, plus one of two blob configs:
 * in the cloud BLOB_ACCOUNT_URL + AZURE_CLIENT_ID (user-assigned managed
 * identity; without the latter the container starts and passes health checks,
 * then fails on the first blob operation — which is why resolveBlobConfig()
 * makes it a startup-time requirement), locally/Azurite BLOB_CONNECTION_STRING.
 * CAS_BASE_URL is optional (transitional, see doc-type-service.ts). CAS access
 * uses the request-local delegated capability; this service has no shared CAS key.
 */
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";
import { consoleObserver } from "@unidocs/protocol-doc";
import { createDocxDocumentType, docxAgent } from "@unidocs/doctype-docx";

runDocTypeService({
  docType: "docx",
  documentTypeFactory: createDocxDocumentType,
  defaultPort: 41810,
  documentAgent: docxAgent,
  llmProvider: createAnthropicProvider(process.env, fetch, { observe: consoleObserver }),
}).catch((err) => {
  console.error("azure-docx failed to start:", err);
  process.exit(1);
});
