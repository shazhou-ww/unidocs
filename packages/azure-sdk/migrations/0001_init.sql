CREATE TABLE deltas (
  doc_type    TEXT    NOT NULL,
  doc_id      TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  timestamp   BIGINT  NOT NULL,
  description TEXT,
  operations  JSONB   NOT NULL,
  PRIMARY KEY (doc_type, doc_id, version)     -- 并发控制的全部依据
);

CREATE TABLE doc_snapshots (
  doc_type  TEXT    NOT NULL,
  doc_id    TEXT    NOT NULL,
  version   INTEGER NOT NULL,
  hash      TEXT    NOT NULL,
  timestamp BIGINT  NOT NULL,
  PRIMARY KEY (doc_type, doc_id, version)
);

CREATE TABLE docs (
  doc_id     TEXT   NOT NULL,
  doc_type   TEXT   NOT NULL,
  owner_id   TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (doc_id, doc_type)
);
CREATE INDEX docs_owner_type_idx ON docs (owner_id, doc_type, updated_at DESC);
