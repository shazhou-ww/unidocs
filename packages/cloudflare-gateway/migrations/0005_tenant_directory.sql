CREATE TABLE gateway_documents_tenant (tenant_id TEXT NOT NULL, doc_id TEXT NOT NULL, doc_type TEXT NOT NULL, service_id TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('creating', 'ready', 'failed')), version INTEGER, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, doc_id), UNIQUE (tenant_id, idempotency_key));
INSERT INTO gateway_documents_tenant (tenant_id, doc_id, doc_type, service_id, session_id, idempotency_key, state, version, error, created_at, updated_at) SELECT tenant_id, doc_id, doc_type, service_id, session_id, idempotency_key, state, version, error, created_at, updated_at FROM gateway_documents;
CREATE TABLE gateway_document_requests_tenant (tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, requested_doc_id TEXT, PRIMARY KEY (tenant_id, idempotency_key));
INSERT INTO gateway_document_requests_tenant (tenant_id, idempotency_key, requested_doc_id) SELECT documents.tenant_id, requests.idempotency_key, requests.requested_doc_id FROM gateway_document_requests AS requests JOIN gateway_documents AS documents USING (owner_id, idempotency_key);
DROP TABLE gateway_document_requests;
DROP TABLE gateway_documents;
ALTER TABLE gateway_documents_tenant RENAME TO gateway_documents;
ALTER TABLE gateway_document_requests_tenant RENAME TO gateway_document_requests;
CREATE INDEX gateway_documents_list_idx ON gateway_documents (tenant_id, doc_type, state, updated_at DESC);