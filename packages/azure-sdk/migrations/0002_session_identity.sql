CREATE TABLE IF NOT EXISTS doc_sessions (
  session_id TEXT NOT NULL PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  doc_type   TEXT NOT NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'deltas'
      AND column_name = 'doc_id'
  ) THEN
    ALTER TABLE deltas RENAME COLUMN doc_id TO session_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'doc_snapshots'
      AND column_name = 'doc_id'
  ) THEN
    ALTER TABLE doc_snapshots RENAME COLUMN doc_id TO session_id;
  END IF;
END $$;
