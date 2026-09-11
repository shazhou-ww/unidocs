CREATE TABLE portal_operator_validations (
  validation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES portal_administrators(member_id),
  document_type TEXT NOT NULL REFERENCES portal_document_types(document_type),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  validated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > validated_at)
);
CREATE INDEX portal_operator_validation_expiry ON portal_operator_validations(expires_at);
CREATE INDEX portal_operator_validation_actor ON portal_operator_validations(actor_id, validation_id);