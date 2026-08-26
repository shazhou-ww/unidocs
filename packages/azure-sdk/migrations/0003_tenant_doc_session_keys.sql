BEGIN;

ALTER TABLE deltas ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE deltas AS deltas
SET tenant_id = sessions.tenant_id
FROM doc_sessions AS sessions
WHERE deltas.session_id = sessions.session_id
  AND deltas.doc_type = sessions.doc_type
  AND deltas.tenant_id IS NULL;
ALTER TABLE deltas ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE doc_snapshots ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE doc_snapshots AS snapshots
SET tenant_id = sessions.tenant_id
FROM doc_sessions AS sessions
WHERE snapshots.session_id = sessions.session_id
  AND snapshots.doc_type = sessions.doc_type
  AND snapshots.tenant_id IS NULL;
ALTER TABLE doc_snapshots ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE deltas DROP CONSTRAINT deltas_pkey;
ALTER TABLE doc_snapshots DROP CONSTRAINT doc_snapshots_pkey;
ALTER TABLE doc_sessions DROP CONSTRAINT doc_sessions_pkey;

ALTER TABLE doc_sessions
  ADD PRIMARY KEY (tenant_id, doc_type, session_id);
ALTER TABLE deltas
  ADD PRIMARY KEY (tenant_id, doc_type, session_id, version),
  ADD CONSTRAINT deltas_session_fk
    FOREIGN KEY (tenant_id, doc_type, session_id)
    REFERENCES doc_sessions (tenant_id, doc_type, session_id);
ALTER TABLE doc_snapshots
  ADD PRIMARY KEY (tenant_id, doc_type, session_id, version),
  ADD CONSTRAINT doc_snapshots_session_fk
    FOREIGN KEY (tenant_id, doc_type, session_id)
    REFERENCES doc_sessions (tenant_id, doc_type, session_id);

COMMIT;