/**
 * Resumable R2 migration for the configured legacy stack.
 *
 * Copies historical stackless keys (`users/{tenant}/nodes/{hash}` and
 * `tenants/{tenant}/nodes/{hash}`) to stack keys
 * (`stacks/{stackId}/tenants/{tenant}/nodes/{hash}`) with an immutable
 * manifest in the tenant D1. Copy-only: source objects are never deleted
 * during migration; deletion is a separate post-contract job that requires a
 * complete, verified manifest. Progress is resumable and idempotent; abort
 * leaves sources untouched.
 *
 * The digest pass reconstructs the canonical node (header + contentType +
 * child hashes + content, via `@unidocs/cas-server-common`) and compares it to
 * the key hash, using an optional metadata source (e.g. the legacy D1).
 */

import type { D1Database } from "@cloudflare/workers-types";
import { computeNodeDigest, encodeHeader, hexToHash, hashToHex } from "@unidocs/cas-server-common";
import { stackNodeKey } from "./do-names.js";

export type R2ManifestStatus = "pending" | "verified" | "failed";

export interface R2MigrationStats {
  readonly total: number;
  readonly copied: number;
  readonly verified: number;
  readonly failed: number;
  readonly remaining: number;
}

export interface R2MigrationOptions {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  /** Only the one configured legacy stack may adopt stackless data. */
  readonly legacyStackId: string;
  /** Historical key prefixes; both known forms by default. */
  readonly sources?: readonly string[];
  readonly maxAttempts?: number;
  readonly now?: () => number;
  readonly onProgress?: (stats: R2MigrationStats) => void;
  /** Optional metadata source for canonical-digest verification. */
  readonly nodeMetadata?: (
    tenantId: string,
    hash: string,
  ) => Promise<{ readonly contentType: string; readonly childHashes: readonly string[] } | null>;
}

const DEFAULT_SOURCES = ["users/", "tenants/"];

/** Parse a historical key into tenant + hash; null when malformed/foreign. */
export function parseHistoricalNodeKey(
  sourceKey: string,
): { tenantId: string; hash: string } | null {
  const match = /^(?:users|tenants)\/([^/]+)\/nodes\/([^/]+)$/.exec(sourceKey);
  if (!match) return null;
  const tenantId = match[1]!;
  const hash = match[2]!;
  if (tenantId.length === 0 || hash.length === 0) return null;
  return { tenantId, hash };
}

/** Record every historical object in the immutable manifest. Idempotent. */
export async function discoverR2Sources(options: R2MigrationOptions): Promise<number> {
  const sources = options.sources ?? DEFAULT_SOURCES;
  let added = 0;
  for (const prefix of sources) {
    let cursor: string | undefined;
    do {
      const listed = await options.bucket.list({ prefix, cursor });
      for (const object of listed.objects) {
        const parsed = parseHistoricalNodeKey(object.key);
        if (!parsed) continue;
        const destination = stackNodeKey(options.legacyStackId, parsed.tenantId, parsed.hash);
        const result = await options.db
          .prepare(
            "INSERT OR IGNORE INTO cas_r2_migration_manifest (source_key, destination_key, stack_id, tenant_id, hash, expected_size, expected_etag, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
          )
          .bind(
            object.key,
            destination,
            options.legacyStackId,
            parsed.tenantId,
            parsed.hash,
            object.size,
            object.etag ?? null,
          )
          .run();
        added += result.meta.changes ?? 0;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor !== undefined);
  }
  return added;
}

/** Copy pending/failed rows and verify destination existence + length. */
export async function runR2Migration(options: R2MigrationOptions): Promise<R2MigrationStats> {
  const now = options.now ?? (() => Date.now());
  const maxAttempts = options.maxAttempts ?? 3;
  await discoverR2Sources(options);
  const rows = await options.db
    .prepare(
      "SELECT source_key, destination_key, stack_id, tenant_id, hash, expected_size, attempt_count, status FROM cas_r2_migration_manifest WHERE status != 'verified' AND attempt_count < ? ORDER BY source_key",
    )
    .bind(maxAttempts)
    .all<ManifestRow>();
  for (const row of rows.results ?? []) {
    const source = await options.bucket.get(row.source_key);
    if (!source) {
      await options.db
        .prepare("UPDATE cas_r2_migration_manifest SET status = 'failed', attempt_count = attempt_count + 1, last_error = 'source missing' WHERE source_key = ?")
        .bind(row.source_key)
        .run();
      continue;
    }
    try {
      // R2 requires a known-length body: read the source to bytes first.
      const bytes = new Uint8Array(await source.arrayBuffer());
      await options.bucket.put(row.destination_key, bytes, {
        httpMetadata: source.httpMetadata,
      });
    } catch (error) {
      await options.db
        .prepare("UPDATE cas_r2_migration_manifest SET status = 'failed', attempt_count = attempt_count + 1, last_error = ? WHERE source_key = ?")
        .bind(errorMessage(error), row.source_key)
        .run();
      continue;
    }
    const destination = await options.bucket.get(row.destination_key);
    const sizeMatches = destination !== null && destination.size === row.expected_size;
    if (destination !== null && sizeMatches) {
      await options.db
        .prepare("UPDATE cas_r2_migration_manifest SET status = 'verified', attempt_count = attempt_count + 1, verified_at = ?, last_error = NULL WHERE source_key = ?")
        .bind(now(), row.source_key)
        .run();
    } else {
      await options.db
        .prepare("UPDATE cas_r2_migration_manifest SET status = 'failed', attempt_count = attempt_count + 1, last_error = 'size mismatch' WHERE source_key = ?")
        .bind(row.source_key)
        .run();
    }
  }
  const stats = await manifestStats(options.db);
  options.onProgress?.(stats);
  return stats;
}

/**
 * Reconstruct the canonical node digest for verified rows (requires the
 * `nodeMetadata` source) and mark mismatches failed.
 */
export async function verifyR2Digests(options: R2MigrationOptions): Promise<{
  verified: number;
  mismatched: number;
  skipped: number;
}> {
  if (!options.nodeMetadata) return { verified: 0, mismatched: 0, skipped: 0 };
  const rows = await options.db
    .prepare("SELECT source_key, destination_key, tenant_id, hash, expected_size FROM cas_r2_migration_manifest WHERE status = 'verified'")
    .all<ManifestRow>();
  let verified = 0;
  let mismatched = 0;
  let skipped = 0;
  for (const row of rows.results ?? []) {
    const metadata = await options.nodeMetadata(row.tenant_id, row.hash);
    if (!metadata) {
      skipped += 1;
      continue;
    }
    const destination = await options.bucket.get(row.destination_key);
    if (!destination) {
      await options.db.prepare("UPDATE cas_r2_migration_manifest SET status = 'failed', last_error = 'destination missing' WHERE source_key = ?").bind(row.source_key).run();
      mismatched += 1;
      continue;
    }
    const content = new Uint8Array(await destination.arrayBuffer());
    const header = encodeHeader(row.expected_size ?? content.length, metadata.contentType, metadata.childHashes.length);
    const digest = await computeNodeDigest(
      header,
      metadata.contentType,
      metadata.childHashes.map(hexToHash),
      content,
    );
    if (hashToHex(digest) === row.hash) {
      verified += 1;
    } else {
      await options.db.prepare("UPDATE cas_r2_migration_manifest SET status = 'failed', last_error = 'digest mismatch' WHERE source_key = ?").bind(row.source_key).run();
      mismatched += 1;
    }
  }
  return { verified, mismatched, skipped };
}

/**
 * Post-contract deletion of migrated source objects. Refuses to run while
 * any row is pending or failed (manifest must be complete).
 */
export async function deleteMigratedSources(options: R2MigrationOptions): Promise<number> {
  const stats = await manifestStats(options.db);
  if (stats.remaining > 0 || stats.failed > 0) {
    throw new Error("R2 migration manifest is incomplete; refusing to delete sources");
  }
  const rows = await options.db
    .prepare("SELECT source_key FROM cas_r2_migration_manifest WHERE status = 'verified' ORDER BY source_key")
    .all<{ source_key: string }>();
  let deleted = 0;
  for (const row of rows.results ?? []) {
    await options.bucket.delete(row.source_key);
    deleted += 1;
  }
  return deleted;
}

export async function manifestStats(db: D1Database): Promise<R2MigrationStats> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM cas_r2_migration_manifest",
    )
    .first<{ total: number; verified: number; failed: number }>();
  const total = row?.total ?? 0;
  const verified = row?.verified ?? 0;
  const failed = row?.failed ?? 0;
  return {
    total,
    copied: verified,
    verified,
    failed,
    remaining: total - verified - failed,
  };
}

interface ManifestRow {
  readonly source_key: string;
  readonly destination_key: string;
  readonly stack_id: string;
  readonly tenant_id: string;
  readonly hash: string;
  readonly expected_size: number;
  readonly expected_etag: string | null;
  readonly attempt_count: number;
  readonly status: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown error";
}
