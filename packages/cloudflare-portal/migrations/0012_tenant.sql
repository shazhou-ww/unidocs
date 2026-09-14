CREATE TABLE portal_documents (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  document_type TEXT NOT NULL,
  current_version_idx INTEGER CHECK (current_version_idx IS NULL OR current_version_idx >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id)
);
CREATE INDEX portal_document_page ON portal_documents(tenant_id, created_at DESC, document_id DESC);
CREATE INDEX portal_document_type_page ON portal_documents(tenant_id, document_type, created_at DESC, document_id DESC);

CREATE TABLE portal_versions (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version_idx INTEGER NOT NULL CHECK (version_idx >= 0),
  parent_version_idx INTEGER CHECK (parent_version_idx IS NULL OR parent_version_idx >= 0),
  document_contract_idx INTEGER NOT NULL CHECK (document_contract_idx >= 0),
  author_agent_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  addressed_comments_json TEXT NOT NULL CHECK (json_valid(addressed_comments_json)),
  snapshot_blob_hash TEXT NOT NULL,
  snapshot_size INTEGER NOT NULL CHECK (snapshot_size >= 0),
  snapshot_content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, version_idx),
  FOREIGN KEY (tenant_id, document_id) REFERENCES portal_documents(tenant_id, document_id)
);

CREATE TABLE portal_threads (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, thread_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES portal_documents(tenant_id, document_id)
);
CREATE INDEX portal_thread_page ON portal_threads(tenant_id, document_id, created_at DESC, thread_id DESC);

CREATE TABLE portal_comments (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  comment_idx INTEGER NOT NULL CHECK (comment_idx >= 0),
  base_version_idx INTEGER NOT NULL CHECK (base_version_idx >= 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, thread_id, comment_idx),
  FOREIGN KEY (tenant_id, document_id, thread_id) REFERENCES portal_threads(tenant_id, document_id, thread_id)
);

CREATE TABLE portal_replies (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  reply_idx INTEGER NOT NULL CHECK (reply_idx >= 0),
  respond_through_comment_idx INTEGER NOT NULL CHECK (respond_through_comment_idx >= 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  result_locations_json TEXT NOT NULL CHECK (json_valid(result_locations_json)),
  author_agent_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, thread_id, reply_idx),
  FOREIGN KEY (tenant_id, document_id, thread_id) REFERENCES portal_threads(tenant_id, document_id, thread_id)
);

CREATE TABLE portal_document_audit (
  audit_event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_version_idx INTEGER CHECK (before_version_idx IS NULL OR before_version_idx >= 0),
  after_version_idx INTEGER CHECK (after_version_idx IS NULL OR after_version_idx >= 0),
  reason TEXT,
  request_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX portal_document_audit_page ON portal_document_audit(tenant_id, document_id, occurred_at DESC, audit_event_id DESC);

CREATE TABLE portal_tenant_idempotency_receipts (
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, operation, key)
);

CREATE TABLE portal_tenant_sessions (
  session_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 28800)
);
CREATE INDEX portal_tenant_session_expiry ON portal_tenant_sessions(expires_at);
