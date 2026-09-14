-- Only committed receipts are stored here (R1): a rejected submission has no
-- persisted trace (design doc §7.3, invariant #3), so there is no `state`
-- column - every row in this table is implicitly "committed".
CREATE TABLE portal_submissions (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, submission_id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES portal_documents(tenant_id, document_id)
);
