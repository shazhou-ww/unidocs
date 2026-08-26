BEGIN;

ALTER TABLE gateway_documents
  DROP CONSTRAINT gateway_documents_pkey,
  DROP CONSTRAINT gateway_documents_owner_id_idempotency_key_key;

DROP INDEX gateway_documents_list_idx;

ALTER TABLE gateway_documents DROP COLUMN owner_id;

ALTER TABLE gateway_documents
  ADD PRIMARY KEY (tenant_id, doc_id),
  ADD CONSTRAINT gateway_documents_tenant_id_idempotency_key_key
    UNIQUE (tenant_id, idempotency_key);

CREATE INDEX gateway_documents_list_idx
  ON gateway_documents (tenant_id, doc_type, state, updated_at DESC);

COMMIT;