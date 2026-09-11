CREATE TABLE portal_administrators (
  member_id TEXT PRIMARY KEY,
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
CREATE UNIQUE INDEX portal_admin_active_email ON portal_administrators(email) WHERE active = 1;
CREATE UNIQUE INDEX portal_admin_active_identity ON portal_administrators(issuer, subject) WHERE active = 1 AND subject IS NOT NULL;
CREATE TABLE portal_bootstrap (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  member_id TEXT NOT NULL REFERENCES portal_administrators(member_id)
);
CREATE TABLE portal_login_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 600)
);
CREATE INDEX portal_login_expiry ON portal_login_transactions(expires_at);
CREATE TABLE portal_session_families (
  family_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES portal_administrators(member_id),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX portal_session_family_member ON portal_session_families(member_id);
CREATE TABLE portal_sessions (
  session_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL UNIQUE REFERENCES portal_session_families(family_id),
  csrf_hash TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 28800)
);
CREATE INDEX portal_session_expiry ON portal_sessions(expires_at);
CREATE TABLE portal_admin_audit (
  audit_event_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  request_id TEXT NOT NULL
);
CREATE INDEX portal_admin_audit_page ON portal_admin_audit(occurred_at DESC, audit_event_id DESC);
CREATE TABLE portal_auth_audit (
  event_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES portal_administrators(member_id),
  action TEXT NOT NULL CHECK (action IN ('session.created', 'session.revoked')),
  occurred_at INTEGER NOT NULL,
  request_id TEXT NOT NULL
);
CREATE TABLE portal_mutation_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);