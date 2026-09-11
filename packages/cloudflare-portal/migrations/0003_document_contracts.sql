ALTER TABLE portal_document_types ADD COLUMN last_contract_idx INTEGER NOT NULL DEFAULT -1 CHECK (last_contract_idx >= -1);
CREATE TABLE portal_document_contracts (
  document_type TEXT NOT NULL REFERENCES portal_document_types(document_type),
  document_contract_idx INTEGER NOT NULL CHECK (document_contract_idx >= 0),
  contract_hash TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_type, document_contract_idx),
  UNIQUE (document_type, contract_hash)
);
CREATE INDEX portal_document_contract_page ON portal_document_contracts(document_type, document_contract_idx DESC);