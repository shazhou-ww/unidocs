import type { D1Database } from "@cloudflare/workers-types";

export interface ContractRoute { readonly method?: string; readonly path?: string }

/** Every contract procedure with its dotted path, found by walking the router object. */
export function contractProcedures(node: unknown, prefix: string[] = []): { name: string; route: ContractRoute }[] {
  if (typeof node !== "object" || node === null) return [];
  const orpc = (node as { "~orpc"?: { route?: ContractRoute } })["~orpc"];
  if (orpc) return [{ name: prefix.join("."), route: orpc.route ?? {} }];
  return Object.entries(node).flatMap(([key, child]) => contractProcedures(child, [...prefix, key]));
}

/** Seeds a minimal document type, its Document Contract, and one version, so a walk can address `documentId`. */
export async function seedDocumentWithVersion(db: D1Database, documentId: string, tenantId = "t-local"): Promise<void> {
  await db.prepare(
    "INSERT OR IGNORE INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES ('markdown', 'markdown', 1, '{}', '2026-09-14T00:00:00.000Z')",
  ).run();
  await db.prepare(
    "INSERT OR IGNORE INTO portal_document_contracts (document_type, document_contract_idx, contract_hash, record_json, created_at) VALUES ('markdown', 0, 'sha256:contract', ?, 0)",
  ).bind(JSON.stringify({
    documentType: "markdown",
    documentContractIdx: 0,
    formatVersion: 1,
    snapshot: {
      contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1",
      schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" },
      schemaHash: "sha256:snapshot",
    },
    location: {
      contentType: "application/vnd.unidocs.markdown.location+json;version=1",
      schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" },
      schemaHash: "sha256:location",
    },
    contractHash: "sha256:contract",
    createdAt: "2026-09-14T00:00:00.000Z",
  })).run();
  await db.prepare(
    "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES (?, ?, 'Notes', 'markdown', 0, 1757808000)",
  ).bind(tenantId, documentId).run();
  await db.prepare(
    `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id, addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
     VALUES (?, ?, 0, NULL, 0, 'agent:test', 'sub-0', '[]', 'hash', 4, 'application/vnd.unidocs.markdown.snapshot+cbor;version=1', 1757808000)`,
  ).bind(tenantId, documentId).run();
}
