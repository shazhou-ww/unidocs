/**
 * CAS D1 schema.
 *
 * Tables: cas_nodes, cas_edges, cas_root_ref_requests.
 * Migration is idempotent (CREATE TABLE IF NOT EXISTS).
 */

const CAS_TABLE_MIGRATIONS = [
  // Migration 1: cas_nodes table
  "CREATE TABLE IF NOT EXISTS cas_nodes (tenant_id TEXT NOT NULL, hash TEXT NOT NULL, content_size INTEGER NOT NULL, content_type TEXT NOT NULL, lease_started_at INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER NOT NULL DEFAULT 0, child_ref_count INTEGER NOT NULL DEFAULT 0 CHECK (child_ref_count >= 0), root_ref_count INTEGER NOT NULL DEFAULT 0 CHECK (root_ref_count >= 0), PRIMARY KEY (tenant_id, hash))",

  // Migration 2: cas_edges table
  "CREATE TABLE IF NOT EXISTS cas_edges (tenant_id TEXT NOT NULL, parent_hash TEXT NOT NULL, ordinal INTEGER NOT NULL, child_hash TEXT NOT NULL, PRIMARY KEY (tenant_id, parent_hash, ordinal))",

  // Migration 4: cas_root_ref_requests table
  "CREATE TABLE IF NOT EXISTS cas_root_ref_requests (tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, request_id))",

  // Migration 5: durable owner ledger for repairable root counts
  "CREATE TABLE IF NOT EXISTS cas_root_owners (tenant_id TEXT NOT NULL, owner TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (tenant_id, owner))",
];

const TENANT_SCOPED_TABLES = [
  "cas_nodes",
  "cas_edges",
  "cas_root_ref_requests",
  "cas_root_owners",
] as const;

const CAS_INDEX_MIGRATIONS = [
  // Migration 3: cas_edges child index
  "CREATE INDEX IF NOT EXISTS cas_edges_by_child ON cas_edges(tenant_id, child_hash)",
  // Migration 6: lookup owners by retained hash
  "CREATE INDEX IF NOT EXISTS cas_root_owners_by_hash ON cas_root_owners(tenant_id, hash)",
];

export const CAS_SCHEMA_MIGRATIONS = [
  ...CAS_TABLE_MIGRATIONS,
  ...CAS_INDEX_MIGRATIONS,
];

/**
 * Run all CAS schema migrations.
 */
export async function migrateCasSchema(db: D1Database): Promise<void> {
  for (const sql of CAS_TABLE_MIGRATIONS) {
    await db.exec(sql);
  }

  // Legacy deployments used the end-user identity as this partition key.
  // Preserve those values while changing the storage contract to tenant
  // semantics. Consolidating several legacy partitions into one tenant needs
  // an explicit Gateway user-to-tenant mapping and is a separate data move.
  for (const table of TENANT_SCOPED_TABLES) {
    const columns = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const names = new Set((columns.results ?? []).map((column) => column.name));
    if (names.has("user_id") && !names.has("tenant_id")) {
      await db.exec(`ALTER TABLE ${table} RENAME COLUMN user_id TO tenant_id`);
    }
  }

  for (const sql of CAS_INDEX_MIGRATIONS) {
    await db.exec(sql);
  }
}
