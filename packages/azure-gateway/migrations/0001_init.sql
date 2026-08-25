CREATE TABLE gateway_documents (
  owner_id        TEXT    NOT NULL,
  doc_id          TEXT    NOT NULL,
  tenant_id       TEXT    NOT NULL,
  doc_type        TEXT    NOT NULL,
  service_id      TEXT    NOT NULL,
  session_id      TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL,
  state           TEXT    NOT NULL CHECK (state IN ('creating', 'ready', 'failed')),
  version         INTEGER,
  error           TEXT,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL,
  PRIMARY KEY (owner_id, doc_id),
  UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX gateway_documents_list_idx
  ON gateway_documents (owner_id, doc_type, state, updated_at DESC);
