/**
 * CAS_CONTROL_DB schema. Operator/stack-administration state is deliberately
 * separate from tenant node data (tenant tables live in the canonical tenant
 * worker's stack-scoped store). Migrations are idempotent
 * (CREATE TABLE/INDEX IF NOT EXISTS plus guarded additive columns) and are run
 * by deployable control-plane ingress adapters at startup.
 */

import type { D1Database } from "@cloudflare/workers-types";

const CONTROL_TABLE_MIGRATIONS = [
  // Operator identities: immutable (iss, sub) key; email/name are display only.
  "CREATE TABLE IF NOT EXISTS cas_operator_identities (identity_issuer TEXT NOT NULL, subject TEXT NOT NULL, display_name TEXT, email_for_display TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (identity_issuer, subject))",

  // Stacks: CAS-generated stack_id; status is operator-managed via the
  // platform plane (suspended) and otherwise active.
  "CREATE TABLE IF NOT EXISTS cas_stacks (stack_id TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')), created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (stack_id))",

  // Equal-authority membership; deleting the last member is rejected.
  "CREATE TABLE IF NOT EXISTS cas_stack_members (stack_id TEXT NOT NULL, identity_issuer TEXT NOT NULL, subject TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (stack_id, identity_issuer, subject))",

  // One-time member invitations; only the token hash is stored.
  "CREATE TABLE IF NOT EXISTS cas_stack_member_invitations (invitation_id TEXT NOT NULL, stack_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')), email_constraint TEXT, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (invitation_id))",

  // Singleton tenant issuer per stack; issuer value is globally unique.
  "CREATE TABLE IF NOT EXISTS cas_stack_issuer (stack_id TEXT NOT NULL, issuer TEXT NOT NULL, audience TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (stack_id))",

  // Issuer keys with explicit lifecycle; possession proof is the activation
  // gate, so keys enter 'active' directly (pending removed by Task 2).
  "CREATE TABLE IF NOT EXISTS cas_stack_issuer_keys (stack_id TEXT NOT NULL, kid TEXT NOT NULL, algorithm TEXT NOT NULL, public_jwk TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','retiring','revoked')), revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (stack_id, kid))",

  // Append-only control audit; never updated or deleted by handlers.
  "CREATE TABLE IF NOT EXISTS cas_control_audit_events (event_id TEXT NOT NULL, stack_id TEXT, identity_issuer TEXT NOT NULL, subject TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, request_id TEXT, trace_id TEXT, caller_channel TEXT, oauth_client_handle TEXT, tool_name TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (event_id))",

  // Creation idempotency: scoped to (identity, method, canonical route).
  "CREATE TABLE IF NOT EXISTS cas_control_idempotency (identity_issuer TEXT NOT NULL, subject TEXT NOT NULL, method TEXT NOT NULL, canonical_route TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (identity_issuer, subject, method, canonical_route, idempotency_key))",

  // One-time possession-proof challenges.
  "CREATE TABLE IF NOT EXISTS cas_possession_challenges (nonce TEXT NOT NULL, stack_id TEXT NOT NULL, kid TEXT NOT NULL, algorithm TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, PRIMARY KEY (nonce))",

  // Encrypted BFF session records; payload is opaque to this library.
  "CREATE TABLE IF NOT EXISTS cas_admin_sessions (session_id TEXT NOT NULL, encrypted_payload TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (session_id))",

  // Global control-data snapshot revision for list-cursor binding.
  "CREATE TABLE IF NOT EXISTS cas_control_meta (key TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (key))",
];

const CONTROL_INDEX_MIGRATIONS = [
  "CREATE INDEX IF NOT EXISTS cas_invitations_by_token_hash ON cas_stack_member_invitations(token_hash)",
  "CREATE UNIQUE INDEX IF NOT EXISTS cas_issuer_by_issuer ON cas_stack_issuer(issuer)",
  "CREATE INDEX IF NOT EXISTS cas_issuer_keys_by_state ON cas_stack_issuer_keys(stack_id, state)",
  "CREATE INDEX IF NOT EXISTS cas_control_audit_by_stack ON cas_control_audit_events(stack_id, created_at, event_id)",
  "CREATE INDEX IF NOT EXISTS cas_control_idempotency_by_expiry ON cas_control_idempotency(expires_at)",
  "CREATE INDEX IF NOT EXISTS cas_admin_sessions_by_expiry ON cas_admin_sessions(expires_at)",
  "CREATE INDEX IF NOT EXISTS cas_possession_challenges_by_expiry ON cas_possession_challenges(expires_at)",
];

export const CONTROL_SCHEMA_MIGRATIONS = [
  ...CONTROL_TABLE_MIGRATIONS,
  ...CONTROL_INDEX_MIGRATIONS,
];

/** Run all CAS_CONTROL_DB migrations. Idempotent and restartable. */
export async function migrateControlSchema(db: D1Database): Promise<void> {
  for (const sql of CONTROL_SCHEMA_MIGRATIONS) {
    await db.exec(sql);
  }
  await ensureColumns(db, "cas_stacks", [
    ["description", "TEXT NOT NULL DEFAULT ''"],
  ]);
  await ensureColumns(db, "cas_control_audit_events", [
    ["caller_channel", "TEXT"],
    ["oauth_client_handle", "TEXT"],
    ["tool_name", "TEXT"],
  ]);
}

async function ensureColumns(
  db: D1Database,
  table: string,
  columns: ReadonlyArray<readonly [name: string, sqlType: string]>,
): Promise<void> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const existing = new Set((result.results ?? []).map((row) => row.name));
  for (const [name, sqlType] of columns) {
    if (existing.has(name)) continue;
    try {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sqlType}`);
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
    }
  }
}
