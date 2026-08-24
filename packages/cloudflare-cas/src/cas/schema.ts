/**
 * CAS D1 schema.
 *
 * Tables: cas_nodes, cas_edges, cas_root_ref_requests.
 * Migration is idempotent (CREATE TABLE IF NOT EXISTS).
 */

export const CAS_SCHEMA_MIGRATIONS = [
  // Migration 1: cas_nodes table
  "CREATE TABLE IF NOT EXISTS cas_nodes (user_id TEXT NOT NULL, hash TEXT NOT NULL, content_size INTEGER NOT NULL, content_type TEXT NOT NULL, lease_started_at INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER NOT NULL DEFAULT 0, child_ref_count INTEGER NOT NULL DEFAULT 0 CHECK (child_ref_count >= 0), root_ref_count INTEGER NOT NULL DEFAULT 0 CHECK (root_ref_count >= 0), PRIMARY KEY (user_id, hash))",

  // Migration 2: cas_edges table
  "CREATE TABLE IF NOT EXISTS cas_edges (user_id TEXT NOT NULL, parent_hash TEXT NOT NULL, ordinal INTEGER NOT NULL, child_hash TEXT NOT NULL, PRIMARY KEY (user_id, parent_hash, ordinal))",

  // Migration 3: cas_edges child index
  "CREATE INDEX IF NOT EXISTS cas_edges_by_child ON cas_edges(user_id, child_hash)",

  // Migration 4: cas_root_ref_requests table
  "CREATE TABLE IF NOT EXISTS cas_root_ref_requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (user_id, request_id))",

  // Migration 5: durable owner ledger for repairable root counts
  "CREATE TABLE IF NOT EXISTS cas_root_owners (user_id TEXT NOT NULL, owner TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (user_id, owner))",

  // Migration 6: lookup owners by retained hash
  "CREATE INDEX IF NOT EXISTS cas_root_owners_by_hash ON cas_root_owners(user_id, hash)",
];

/**
 * Run all CAS schema migrations.
 */
export async function migrateCasSchema(db: D1Database): Promise<void> {
  for (const sql of CAS_SCHEMA_MIGRATIONS) {
    await db.exec(sql);
  }
}
