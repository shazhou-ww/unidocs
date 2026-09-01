BEGIN;

CREATE TABLE gateway_oauth_clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris_json JSONB NOT NULL,
  client_name TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE gateway_oauth_authorization_transactions (
  transaction_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT,
  requested_scopes_json JSONB NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE INDEX gateway_oauth_transactions_expiry_idx ON gateway_oauth_authorization_transactions (expires_at);

CREATE TABLE gateway_oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  scopes_json JSONB NOT NULL,
  permissions_json JSONB NOT NULL,
  code_challenge TEXT NOT NULL,
  ref_domain TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE INDEX gateway_oauth_codes_expiry_idx ON gateway_oauth_authorization_codes (expires_at);

CREATE TABLE gateway_oauth_refresh_families (
  family_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT,
  replayed_at BIGINT
);

CREATE TABLE gateway_oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES gateway_oauth_refresh_families (family_id),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  client_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  scopes_json JSONB NOT NULL,
  permissions_json JSONB NOT NULL,
  ref_domain TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT,
  successor_hash TEXT,
  UNIQUE (family_id, generation)
);
CREATE INDEX gateway_oauth_refresh_expiry_idx ON gateway_oauth_refresh_tokens (expires_at);

CREATE TABLE gateway_oauth_tenant_memberships (
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  scopes_json JSONB NOT NULL,
  ref_domain TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (principal_id, tenant_id)
);

CREATE TABLE gateway_oauth_audit_events (
  event_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  client_id TEXT NOT NULL,
  principal_id TEXT,
  tenant_id TEXT,
  scopes_json JSONB,
  reason TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX gateway_oauth_audit_tenant_time_idx ON gateway_oauth_audit_events (tenant_id, created_at, event_id);

COMMIT;
