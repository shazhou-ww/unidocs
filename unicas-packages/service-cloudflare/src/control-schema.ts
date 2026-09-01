/**
 * CAS_CONTROL_DB schema owned by the Cloudflare deployment adapter.
 * Operator state is deliberately separate from tenant node data. Migrations
 * are idempotent and restartable so hosts can safely initialize each binding.
 */

import type { D1Database } from "@cloudflare/workers-types";

const CONTROL_TABLE_MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS cas_operator_identities (identity_issuer TEXT NOT NULL, subject TEXT NOT NULL, display_name TEXT, email_for_display TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (identity_issuer, subject))",
  "CREATE TABLE IF NOT EXISTS cas_stacks (stack_id TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')), created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (stack_id))",
  "CREATE TABLE IF NOT EXISTS cas_stack_members (stack_id TEXT NOT NULL, identity_issuer TEXT NOT NULL, subject TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (stack_id, identity_issuer, subject))",
  "CREATE TABLE IF NOT EXISTS cas_stack_member_invitations (invitation_id TEXT NOT NULL, stack_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')), email_constraint TEXT, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (invitation_id))",
  "CREATE TABLE IF NOT EXISTS cas_stack_issuer (stack_id TEXT NOT NULL, issuer TEXT NOT NULL, audience TEXT NOT NULL, capability_max_lifetime_seconds INTEGER NOT NULL DEFAULT 28800 CHECK (capability_max_lifetime_seconds BETWEEN 60 AND 604800), revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (stack_id))",
  "CREATE TABLE IF NOT EXISTS cas_stack_issuer_keys (stack_id TEXT NOT NULL, kid TEXT NOT NULL, algorithm TEXT NOT NULL, public_jwk TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','retiring','revoked')), revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (stack_id, kid))",
  "CREATE TABLE IF NOT EXISTS cas_stack_oauth_issuers (stack_id TEXT NOT NULL, issuer TEXT NOT NULL, audience TEXT NOT NULL, metadata_url TEXT NOT NULL, metadata_type TEXT NOT NULL CHECK (metadata_type IN ('oauth','oidc')), authorization_endpoint TEXT NOT NULL, token_endpoint TEXT NOT NULL, jwks_uri TEXT NOT NULL, registration_endpoint TEXT, scopes_supported TEXT NOT NULL DEFAULT '[]', code_challenge_methods_supported TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK (status IN ('pending','active','stale','incompatible','disabled')), verified_at INTEGER, last_refresh_at INTEGER, last_refresh_error TEXT, jwks_digest TEXT NOT NULL, capability_max_lifetime_seconds INTEGER NOT NULL DEFAULT 28800 CHECK (capability_max_lifetime_seconds BETWEEN 60 AND 604800), revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (stack_id))",
  "CREATE TABLE IF NOT EXISTS cas_oauth_issuer_inspections (inspection_id TEXT NOT NULL, stack_id TEXT NOT NULL, issuer TEXT NOT NULL, audience TEXT NOT NULL, metadata_url TEXT NOT NULL, metadata_type TEXT NOT NULL CHECK (metadata_type IN ('oauth','oidc')), authorization_endpoint TEXT NOT NULL, token_endpoint TEXT NOT NULL, jwks_uri TEXT NOT NULL, registration_endpoint TEXT, scopes_supported TEXT NOT NULL DEFAULT '[]', code_challenge_methods_supported TEXT NOT NULL DEFAULT '[]', metadata_digest TEXT NOT NULL, jwks_digest TEXT NOT NULL, challenge_hash TEXT NOT NULL, capability_max_lifetime_seconds INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (inspection_id))",
  "CREATE TABLE IF NOT EXISTS cas_oauth_issuer_inspection_keys (inspection_id TEXT NOT NULL, kid TEXT NOT NULL, algorithm TEXT NOT NULL, public_jwk TEXT NOT NULL, PRIMARY KEY (inspection_id, kid))",
  "CREATE TABLE IF NOT EXISTS cas_stack_oauth_issuer_keys (stack_id TEXT NOT NULL, kid TEXT NOT NULL, algorithm TEXT NOT NULL, public_jwk TEXT NOT NULL, jwks_digest TEXT NOT NULL, activated_at INTEGER NOT NULL, PRIMARY KEY (stack_id, kid))",
  "CREATE TABLE IF NOT EXISTS cas_control_audit_events (event_id TEXT NOT NULL, stack_id TEXT, identity_issuer TEXT NOT NULL, subject TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, request_id TEXT, trace_id TEXT, caller_channel TEXT, oauth_client_handle TEXT, tool_name TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (event_id))",
  "CREATE TABLE IF NOT EXISTS cas_control_idempotency (identity_issuer TEXT NOT NULL, subject TEXT NOT NULL, method TEXT NOT NULL, canonical_route TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (identity_issuer, subject, method, canonical_route, idempotency_key))",
  "CREATE TABLE IF NOT EXISTS cas_possession_challenges (nonce TEXT NOT NULL, stack_id TEXT NOT NULL, kid TEXT NOT NULL, algorithm TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, PRIMARY KEY (nonce))",
  "CREATE TABLE IF NOT EXISTS cas_admin_sessions (session_id TEXT NOT NULL, encrypted_payload TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (session_id))",
  "CREATE TABLE IF NOT EXISTS cas_control_meta (key TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (key))",
];

const CONTROL_INDEX_MIGRATIONS = [
  "CREATE INDEX IF NOT EXISTS cas_invitations_by_token_hash ON cas_stack_member_invitations(token_hash)",
  "CREATE UNIQUE INDEX IF NOT EXISTS cas_issuer_by_issuer ON cas_stack_issuer(issuer)",
  "CREATE UNIQUE INDEX IF NOT EXISTS cas_oauth_issuer_by_issuer ON cas_stack_oauth_issuers(issuer)",
  "CREATE INDEX IF NOT EXISTS cas_oauth_issuers_by_status ON cas_stack_oauth_issuers(status, stack_id)",
  "CREATE INDEX IF NOT EXISTS cas_oauth_inspections_by_stack ON cas_oauth_issuer_inspections(stack_id, created_at)",
  "CREATE INDEX IF NOT EXISTS cas_oauth_inspections_by_expiry ON cas_oauth_issuer_inspections(expires_at)",
  "CREATE INDEX IF NOT EXISTS cas_issuer_keys_by_state ON cas_stack_issuer_keys(stack_id, state)",
  "CREATE INDEX IF NOT EXISTS cas_control_audit_by_stack ON cas_control_audit_events(stack_id, created_at, event_id)",
  "CREATE INDEX IF NOT EXISTS cas_control_idempotency_by_expiry ON cas_control_idempotency(expires_at)",
  "CREATE INDEX IF NOT EXISTS cas_admin_sessions_by_expiry ON cas_admin_sessions(expires_at)",
  "CREATE INDEX IF NOT EXISTS cas_possession_challenges_by_expiry ON cas_possession_challenges(expires_at)",
  "CREATE TRIGGER IF NOT EXISTS cas_legacy_issuer_cross_registry_insert BEFORE INSERT ON cas_stack_issuer WHEN EXISTS (SELECT 1 FROM cas_stack_oauth_issuers WHERE issuer = NEW.issuer AND stack_id != NEW.stack_id) BEGIN SELECT RAISE(ABORT, 'issuer conflict'); END",
  "CREATE TRIGGER IF NOT EXISTS cas_legacy_issuer_cross_registry_update BEFORE UPDATE OF issuer ON cas_stack_issuer WHEN EXISTS (SELECT 1 FROM cas_stack_oauth_issuers WHERE issuer = NEW.issuer AND stack_id != NEW.stack_id) BEGIN SELECT RAISE(ABORT, 'issuer conflict'); END",
  "CREATE TRIGGER IF NOT EXISTS cas_oauth_issuer_cross_registry_insert BEFORE INSERT ON cas_stack_oauth_issuers WHEN EXISTS (SELECT 1 FROM cas_stack_issuer WHERE issuer = NEW.issuer AND stack_id != NEW.stack_id) BEGIN SELECT RAISE(ABORT, 'issuer conflict'); END",
  "CREATE TRIGGER IF NOT EXISTS cas_oauth_issuer_cross_registry_update BEFORE UPDATE OF issuer ON cas_stack_oauth_issuers WHEN EXISTS (SELECT 1 FROM cas_stack_issuer WHERE issuer = NEW.issuer AND stack_id != NEW.stack_id) BEGIN SELECT RAISE(ABORT, 'issuer conflict'); END",
];

export const CONTROL_SCHEMA_MIGRATIONS = [
  ...CONTROL_TABLE_MIGRATIONS,
  ...CONTROL_INDEX_MIGRATIONS,
];

export async function migrateControlSchema(db: D1Database): Promise<void> {
  for (const sql of CONTROL_SCHEMA_MIGRATIONS) await db.exec(sql);
  await ensureColumns(db, "cas_stacks", [["description", "TEXT NOT NULL DEFAULT ''"]]);
  await ensureColumns(db, "cas_control_audit_events", [
    ["caller_channel", "TEXT"],
    ["oauth_client_handle", "TEXT"],
    ["tool_name", "TEXT"],
  ]);
  await ensureColumns(db, "cas_stack_issuer", [
    ["capability_max_lifetime_seconds", "INTEGER NOT NULL DEFAULT 28800"],
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
