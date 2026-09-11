CREATE TABLE portal_operators (
  operator_id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL REFERENCES portal_document_types(document_type),
  base_url TEXT NOT NULL,
  declared_operator_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX portal_operator_page ON portal_operators(document_type, created_at DESC, operator_id DESC);