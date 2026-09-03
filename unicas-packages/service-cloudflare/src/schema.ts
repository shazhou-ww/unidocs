/**
 * Stack-scoped tenant storage schema (canonical CAS server).
 *
 * Every tenant-owned key carries the stable `stackId` namespace so two stacks
 * sharing a textual `tenantId` never share nodes, edges, idempotency, audit,
 * leases, usage, or GC. The domain event/projection/revision tables are the
 * strongly-recorded audit projection; `cas_nodes.root_ref_count` remains the
 * only authoritative lifecycle input.
 */

import type { D1Database } from "@cloudflare/workers-types";

const TABLE_MIGRATIONS = [
  // Authoritative node rows: (stackId, tenantId, hash).
  "CREATE TABLE IF NOT EXISTS cas_nodes (stack_id TEXT NOT NULL, tenant_id TEXT NOT NULL, hash TEXT NOT NULL, content_size INTEGER NOT NULL, content_type TEXT NOT NULL, lease_started_at INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER NOT NULL DEFAULT 0, child_ref_count INTEGER NOT NULL DEFAULT 0 CHECK (child_ref_count >= 0), root_ref_count INTEGER NOT NULL DEFAULT 0 CHECK (root_ref_count >= 0), PRIMARY KEY (stack_id, tenant_id, hash))",

  // Edges: parent -> children with ordinal.
  "CREATE TABLE IF NOT EXISTS cas_edges (stack_id TEXT NOT NULL, tenant_id TEXT NOT NULL, parent_hash TEXT NOT NULL, ordinal INTEGER NOT NULL, child_hash TEXT NOT NULL, PRIMARY KEY (stack_id, tenant_id, parent_hash, ordinal))",

  // Domain-scoped idempotency: (stackId, tenantId, refDomain, requestId).
  "CREATE TABLE IF NOT EXISTS cas_root_ref_requests (stack_id TEXT NOT NULL, tenant_id TEXT NOT NULL, ref_domain TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (stack_id, tenant_id, ref_domain, request_id))",

  // Domain event log (strongly recorded audit; append-only).
  "CREATE TABLE IF NOT EXISTS cas_root_domain_events (stack_id TEXT NOT NULL, ref_domain TEXT NOT NULL, revision INTEGER NOT NULL, tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, changes_json TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (stack_id, ref_domain, revision))",

  // Current-balance projection per (stackId, refDomain, tenantId, hash).
  "CREATE TABLE IF NOT EXISTS cas_root_domain_refs (stack_id TEXT NOT NULL, ref_domain TEXT NOT NULL, tenant_id TEXT NOT NULL, hash TEXT NOT NULL, ref_count INTEGER NOT NULL, PRIMARY KEY (stack_id, ref_domain, tenant_id, hash))",

  // Per-(stackId, refDomain) monotonic revision allocator.
  "CREATE TABLE IF NOT EXISTS cas_root_domain_revisions (stack_id TEXT NOT NULL, ref_domain TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (stack_id, ref_domain))",

  // Internal quota reservation for the R2-before-D1 node commit window.
  "CREATE TABLE IF NOT EXISTS cas_upload_reservations (stack_id TEXT NOT NULL, tenant_id TEXT NOT NULL, hash TEXT NOT NULL, stored_bytes INTEGER NOT NULL CHECK (stored_bytes > 0), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (stack_id, tenant_id, hash))",

  // Direct-to-R2 upload sessions. Ready state remains represented only by cas_nodes.
  "CREATE TABLE IF NOT EXISTS cas_direct_upload_sessions (stack_id TEXT NOT NULL, tenant_id TEXT NOT NULL, hash TEXT NOT NULL, upload_id TEXT NOT NULL, temporary_object_key TEXT NOT NULL, stored_bytes INTEGER NOT NULL CHECK (stored_bytes > 0), lease_duration_ms INTEGER NOT NULL CHECK (lease_duration_ms > 0), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (stack_id, tenant_id, hash), UNIQUE (upload_id), UNIQUE (temporary_object_key))",
];

const INDEX_MIGRATIONS = [
  "CREATE INDEX IF NOT EXISTS cas_edges_by_child ON cas_edges(stack_id, tenant_id, child_hash)",
  "CREATE INDEX IF NOT EXISTS cas_root_domain_events_by_request ON cas_root_domain_events(stack_id, tenant_id, ref_domain, request_id)",
  "CREATE INDEX IF NOT EXISTS cas_root_domain_refs_by_scan ON cas_root_domain_refs(stack_id, ref_domain, tenant_id, hash)",
];

export const STACK_TENANT_SCHEMA_MIGRATIONS = [
  ...TABLE_MIGRATIONS,
  ...INDEX_MIGRATIONS,
];

/** Initialize the stack-scoped tenant schema. Idempotent. */
export async function migrateStackTenantSchema(db: D1Database): Promise<void> {
  for (const sql of STACK_TENANT_SCHEMA_MIGRATIONS) {
    await db.exec(sql);
  }
}
