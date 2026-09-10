CREATE TABLE portal_document_types (
  document_type TEXT PRIMARY KEY,
  internal_name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  registration_json TEXT NOT NULL CHECK (json_valid(registration_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE portal_idempotency_receipts (
  actor_id TEXT NOT NULL REFERENCES portal_administrators(member_id),
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, operation, key)
);
ALTER TABLE portal_admin_audit ADD COLUMN document_type TEXT;
ALTER TABLE portal_admin_audit ADD COLUMN reason TEXT;
ALTER TABLE portal_admin_audit ADD COLUMN details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json));