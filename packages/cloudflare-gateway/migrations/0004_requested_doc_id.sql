CREATE TABLE IF NOT EXISTS gateway_document_requests (owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, requested_doc_id TEXT, PRIMARY KEY (owner_id, idempotency_key));
