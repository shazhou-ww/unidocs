CREATE TABLE IF NOT EXISTS doc_sessions (
  session_id TEXT NOT NULL PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  doc_type   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deltas (
  doc_type    TEXT    NOT NULL,
  session_id  TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  timestamp   BIGINT  NOT NULL,
  description TEXT,
  operations  JSONB   NOT NULL,
  PRIMARY KEY (doc_type, session_id, version)     -- 并发控制的全部依据
);
CREATE TABLE IF NOT EXISTS doc_snapshots (
  doc_type  TEXT    NOT NULL,
  session_id TEXT   NOT NULL,
  version   INTEGER NOT NULL,
  hash      TEXT    NOT NULL,
  timestamp BIGINT  NOT NULL,
  PRIMARY KEY (doc_type, session_id, version)
);
