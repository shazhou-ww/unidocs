-- Bookkeeping for the two at-least-once dead ends of the Operator loop
-- (tenant data plane spec §18).
--
-- When a session reader last asked the Operator, again, to initialize a
-- document that still has no version. NULL means only the dispatch that
-- followed createDocument has happened; its time is the row's created_at.
ALTER TABLE portal_documents ADD COLUMN initialization_redelivered_at INTEGER;

-- When the Portal's retain of a version's snapshot blob landed in UniCAS.
-- NULL means the version committed but its blob is still only leased, and the
-- retention sweep must retain it before UniCAS GC can collect it.
ALTER TABLE portal_versions ADD COLUMN snapshot_retained_at INTEGER;

-- When a retain was last tried and failed. The sweep takes the rows that have
-- waited longest since creation or since their last failure, so a row that
-- keeps failing moves to the back instead of holding up the batch.
ALTER TABLE portal_versions ADD COLUMN snapshot_retain_attempted_at INTEGER;

-- When UniCAS answered that the blob no longer exists: GC collected it before
-- anyone retained it. Nothing can repair that, so the sweep stops asking.
ALTER TABLE portal_versions ADD COLUMN snapshot_lost_at INTEGER;

-- Versions committed before this column existed were retained under a random
-- requestId that cannot be replayed, so retaining them again would count a
-- second reference that nothing ever releases. They are taken as retained.
UPDATE portal_versions SET snapshot_retained_at = created_at;

CREATE INDEX portal_version_unretained ON portal_versions(COALESCE(snapshot_retain_attempted_at, created_at))
  WHERE snapshot_retained_at IS NULL AND snapshot_lost_at IS NULL;
