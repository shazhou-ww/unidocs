CREATE TABLE portal_view_bundle_reservations (
  content_hash TEXT PRIMARY KEY,
  view_bundle_id TEXT NOT NULL UNIQUE,
  document_type TEXT NOT NULL REFERENCES portal_document_types(document_type),
  actor_id TEXT NOT NULL REFERENCES portal_administrators(member_id),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (actor_id, idempotency_key)
);
CREATE INDEX portal_view_bundle_reservation_expiry ON portal_view_bundle_reservations(created_at);
CREATE TABLE portal_view_bundles (
  view_bundle_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  document_type TEXT NOT NULL REFERENCES portal_document_types(document_type),
  bundle_root_key TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX portal_view_bundle_page ON portal_view_bundles(document_type, uploaded_at DESC, view_bundle_id DESC);