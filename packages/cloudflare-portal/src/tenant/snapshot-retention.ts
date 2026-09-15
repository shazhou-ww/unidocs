/**
 * Keeps every committed version's snapshot blob rooted in UniCAS.
 *
 * An Agent writes a snapshot blob, which UniCAS only leases (15 minutes by
 * default); the Portal retains it after the submission commits (R8). A retain
 * that fails, or a worker that dies between the D1 commit and the retain,
 * would leave a committed version pointing at a blob the next UniCAS GC may
 * collect, after which the snapshot is unreadable for good (spec §18).
 *
 * So the retain is made repeatable and its outcome is recorded:
 *
 * - its requestId is derived from the version, not the HTTP request. UniCAS
 *   remembers a root-refs requestId indefinitely and applies an identical
 *   payload once, so retaining the same version any number of times, from any
 *   request, counts one reference;
 * - `portal_versions.snapshot_retained_at` is set only after UniCAS accepted
 *   it, so NULL is exactly "not known to be retained";
 * - `sweep` retains those rows. A lease that has expired does not stop it:
 *   UniCAS still retains a node GC has not yet collected. Only a collected
 *   node is beyond repair: it is logged as `portal_snapshot_lost`, recorded in
 *   `snapshot_lost_at`, and never asked for again.
 *
 * Nothing here throws. Any other failure is logged, its time recorded in
 * `snapshot_retain_attempted_at`, and the row stays unretained; the sweep
 * orders by that time, so rows that keep failing cannot starve the others.
 */
import { CasClientError } from "@unicas/tenant-blob-client";
import type { SnapshotStore } from "../snapshot-store.js";

export interface SnapshotRetentionOptions {
  readonly database: D1Database;
  /** The store for a tenant; a CAS capability is tenant-scoped. */
  readonly snapshots: (tenantId: string) => SnapshotStore;
  readonly now?: () => Date;
}

export interface SnapshotRetention {
  /** Retains one version's snapshot unless it is already recorded as retained. */
  retainVersion(tenantId: string, documentId: string, versionIdx: number): Promise<void>;
  /**
   * Retains at most `limit` unretained versions, those waiting longest since
   * creation or since their last failed attempt, once that wait exceeds
   * `graceSeconds`. The grace period leaves a version alone while the
   * submission request that committed it is still retaining it, and paces a
   * version whose retain keeps failing. Versions whose blob is lost are skipped.
   */
  sweep(options?: { readonly limit?: number; readonly graceSeconds?: number }): Promise<{ retained: number; failed: number }>;
}

interface VersionRow {
  readonly tenant_id: string;
  readonly document_id: string;
  readonly version_idx: number;
  readonly snapshot_blob_hash: string;
  readonly snapshot_size: number;
  readonly snapshot_content_type: string;
}

const SWEEP_LIMIT = 20;
const SWEEP_GRACE_SECONDS = 60;

export function snapshotRetainRequestId(documentId: string, versionIdx: number): string {
  return `portal-version-snapshot:${documentId}:${versionIdx}`;
}

function failure(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) };
}

export function createSnapshotRetention(options: SnapshotRetentionOptions): SnapshotRetention {
  const { database } = options;
  const nowSeconds = () => Math.floor((options.now?.() ?? new Date()).getTime() / 1000);

  /** Writes one outcome column; a failure to record it is logged and otherwise ignored. */
  async function record(row: VersionRow, column: "snapshot_retained_at" | "snapshot_retain_attempted_at" | "snapshot_lost_at"): Promise<void> {
    try {
      await database.prepare(
        `UPDATE portal_versions SET ${column} = ?4
         WHERE tenant_id = ?1 AND document_id = ?2 AND version_idx = ?3 AND snapshot_retained_at IS NULL`,
      ).bind(row.tenant_id, row.document_id, row.version_idx, nowSeconds()).run();
    } catch (error) {
      // CAS already answered; only the bookkeeping failed. Retrying the retain
      // later is safe, because it replays the same requestId.
      console.error(JSON.stringify({
        event: "portal_snapshot_retention_record_failed", tenantId: row.tenant_id, documentId: row.document_id, versionIdx: row.version_idx, column, ...failure(error),
      }));
    }
  }

  async function retainRow(row: VersionRow): Promise<boolean> {
    try {
      await options.snapshots(row.tenant_id).retain(
        { blobHash: row.snapshot_blob_hash, size: row.snapshot_size, contentType: row.snapshot_content_type },
        snapshotRetainRequestId(row.document_id, row.version_idx),
      );
    } catch (error) {
      // UniCAS answers 404 NODE_NOT_FOUND only once GC has collected the blob.
      const lost = error instanceof CasClientError && error.status === 404;
      console.error(JSON.stringify({
        event: lost ? "portal_snapshot_lost" : "portal_snapshot_retain_failed",
        tenantId: row.tenant_id, documentId: row.document_id, versionIdx: row.version_idx, blobHash: row.snapshot_blob_hash, ...failure(error),
      }));
      await record(row, lost ? "snapshot_lost_at" : "snapshot_retain_attempted_at");
      return false;
    }
    await record(row, "snapshot_retained_at");
    return true;
  }

  return {
    async retainVersion(tenantId, documentId, versionIdx) {
      let row: VersionRow | null;
      try {
        row = await database.prepare(
          `SELECT tenant_id, document_id, version_idx, snapshot_blob_hash, snapshot_size, snapshot_content_type FROM portal_versions
           WHERE tenant_id = ?1 AND document_id = ?2 AND version_idx = ?3 AND snapshot_retained_at IS NULL AND snapshot_lost_at IS NULL`,
        ).bind(tenantId, documentId, versionIdx).first<VersionRow>();
      } catch (error) {
        console.error(JSON.stringify({ event: "portal_snapshot_retention_read_failed", tenantId, documentId, versionIdx, ...failure(error) }));
        return;
      }
      if (row) await retainRow(row);
    },

    async sweep(sweepOptions = {}) {
      const result = { retained: 0, failed: 0 };
      let rows: VersionRow[];
      try {
        ({ results: rows } = await database.prepare(
          `SELECT tenant_id, document_id, version_idx, snapshot_blob_hash, snapshot_size, snapshot_content_type FROM portal_versions
           WHERE snapshot_retained_at IS NULL AND snapshot_lost_at IS NULL
             AND COALESCE(snapshot_retain_attempted_at, created_at) <= ?1
           ORDER BY COALESCE(snapshot_retain_attempted_at, created_at), tenant_id, document_id, version_idx LIMIT ?2`,
        ).bind(nowSeconds() - (sweepOptions.graceSeconds ?? SWEEP_GRACE_SECONDS), sweepOptions.limit ?? SWEEP_LIMIT).all<VersionRow>());
      } catch (error) {
        console.error(JSON.stringify({ event: "portal_snapshot_retention_sweep_failed", ...failure(error) }));
        return result;
      }
      for (const row of rows) {
        if (await retainRow(row)) result.retained += 1;
        else result.failed += 1;
      }
      return result;
    },
  };
}
