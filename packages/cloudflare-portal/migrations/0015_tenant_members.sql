-- Tenant members: who may hold a tenant session, and as which principal.
-- Rows are never deleted; removal only clears `active`, so principal history
-- stays resolvable. One person, one tenant: both active indexes are global.
CREATE TABLE portal_tenant_members (
  member_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  email TEXT NOT NULL,
  issuer TEXT,
  subject TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((issuer IS NULL) = (subject IS NULL))
);
CREATE UNIQUE INDEX portal_tenant_member_active_email ON portal_tenant_members(email) WHERE active = 1;
CREATE UNIQUE INDEX portal_tenant_member_active_identity ON portal_tenant_members(issuer, subject) WHERE active = 1 AND subject IS NOT NULL;
CREATE UNIQUE INDEX portal_tenant_member_principal ON portal_tenant_members(tenant_id, principal_id);

CREATE TABLE portal_tenant_login_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 600)
);
CREATE INDEX portal_tenant_login_expiry ON portal_tenant_login_transactions(expires_at);

CREATE TABLE portal_tenant_auth_audit (
  event_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES portal_tenant_members(member_id),
  action TEXT NOT NULL CHECK (action IN ('member.bound', 'session.created', 'session.revoked')),
  occurred_at INTEGER NOT NULL,
  request_id TEXT NOT NULL
);

CREATE INDEX portal_tenant_session_principal ON portal_tenant_sessions(tenant_id, principal_id, created_at);
