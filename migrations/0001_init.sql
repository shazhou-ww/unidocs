CREATE TABLE IF NOT EXISTS snapshots (hash TEXT NOT NULL, doc_type TEXT NOT NULL, doc_id TEXT NOT NULL, version INTEGER NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY (doc_type, doc_id, version));
CREATE TABLE IF NOT EXISTS docs (doc_id TEXT NOT NULL, doc_type TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (doc_id, doc_type));
