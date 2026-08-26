/**
 * Stack-scoped tenant storage schema (canonical CAS server).
 *
 * Every tenant-owned key carries the stable `stackId` namespace so two stacks
 * sharing a textual `tenantId` never share nodes, edges, idempotency, audit,
 * leases, usage, or GC. The domain event/projection/revision tables are the
 * strongly-recorded audit projection; `cas_nodes.root_ref_count` remains the
 * only authoritative lifecycle input. The schema/cutover record and the R2
 * migration manifest are durable migration state.
 *
 * Option A remap: this is the fresh target schema for `cas-server-cloudflare`;
 * the legacy stackless runtime has been retired (its frozen protocol lives on
 * in `@unicas/protocol-legacy`). Historical data import (R2 copy +
 * `_legacy` baseline) is driven by the migration jobs in this package.
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

  // Durable schema/cutover record (migration state, not tenant data).
  "CREATE TABLE IF NOT EXISTS cas_schema_meta (key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (key))",

  // Immutable R2 migration manifest rows.
  "CREATE TABLE IF NOT EXISTS cas_r2_migration_manifest (source_key TEXT NOT NULL, destination_key TEXT NOT NULL, stack_id TEXT NOT NULL, tenant_id TEXT NOT NULL, hash TEXT NOT NULL, expected_size INTEGER, expected_etag TEXT, expected_digest TEXT, status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, verified_at INTEGER, PRIMARY KEY (source_key))",
];

const INDEX_MIGRATIONS = [
  "CREATE INDEX IF NOT EXISTS cas_edges_by_child ON cas_edges(stack_id, tenant_id, child_hash)",
  "CREATE INDEX IF NOT EXISTS cas_root_domain_events_by_request ON cas_root_domain_events(stack_id, tenant_id, ref_domain, request_id)",
  "CREATE INDEX IF NOT EXISTS cas_root_domain_refs_by_scan ON cas_root_domain_refs(stack_id, ref_domain, tenant_id, hash)",
  "CREATE INDEX IF NOT EXISTS cas_r2_manifest_by_status ON cas_r2_migration_manifest(status, stack_id)",
];

export const STACK_TENANT_SCHEMA_MIGRATIONS = [
  ...TABLE_MIGRATIONS,
  ...INDEX_MIGRATIONS,
];

/** Run all stack-scoped tenant schema migrations. Idempotent and restartable. */
export async function migrateStackTenantSchema(db: D1Database): Promise<void> {
  for (const sql of STACK_TENANT_SCHEMA_MIGRATIONS) {
    await db.exec(sql);
  }
}

// ----------------------------------------------------------------------
// Schema/cutover record
// ----------------------------------------------------------------------

export const SCHEMA_VERSION = "1";

export type CutoverState = "provisioned" | "migrating" | "cutover" | "contracted";

export const CUTOVER_STATE_KEY = "cutover_state";
export const LEGACY_STACK_ID_KEY = "legacy_stack_id";

export async function readSchemaMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM cas_schema_meta WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function readCutoverState(db: D1Database): Promise<CutoverState> {
  const value = await readSchemaMeta(db, CUTOVER_STATE_KEY);
  if (
    value === "provisioned"
    || value === "migrating"
    || value === "cutover"
    || value === "contracted"
  ) {
    return value;
  }
  return "provisioned";
}

export async function writeCutoverState(db: D1Database, state: CutoverState): Promise<void> {
  await db
    .prepare("INSERT INTO cas_schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(CUTOVER_STATE_KEY, state)
    .run();
}

export async function readLegacyStackId(db: D1Database): Promise<string | null> {
  return readSchemaMeta(db, LEGACY_STACK_ID_KEY);
}

export async function writeLegacyStackId(db: D1Database, stackId: string): Promise<void> {
  await db
    .prepare("INSERT INTO cas_schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(LEGACY_STACK_ID_KEY, stackId)
    .run();
}
