/**
 * Reserved `_legacy` audit baseline migration.
 *
 * Pre-existing aggregate root counts have no reliable domain attribution, so
 * the migration must not fabricate one. This importer writes deterministic
 * baseline events and current-balance rows under the reserved, non-callable
 * `_legacy` domain for every positive aggregate count, preserving the
 * diagnostic equality
 *
 *   aggregate root_ref_count == sum of all audit domain balances
 *
 * Aggregate counts are never touched. Processing is deterministic (canonical
 * tenant order, canonical hash order, batches of at most 1000 changes) with
 * request IDs derived from the migration version, stack, tenant, and
 * tenant-local batch ordinal; revisions are allocated in the deterministic
 * global batch order, so rerunning matches the same request IDs and payloads
 * and appends no duplicate events.
 */

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { LEGACY_DOMAIN } from "@unidocs/cas-control-plane";
import { canonicalJson, sha256Hex } from "@unidocs/cas-control-plane";

export const LEGACY_BASELINE_MAX_BATCH = 1000;

export interface LegacyBaselineRow {
  readonly tenantId: string;
  readonly hash: string;
  /** Positive aggregate root count to baseline. */
  readonly rootRefCount: number;
}

export interface LegacyBaselineResult {
  readonly batches: number;
  readonly events: number;
  readonly projectionRows: number;
  readonly finalRevision: number;
}

export async function runLegacyBaseline(
  db: D1Database,
  input: {
    readonly stackId: string;
    readonly rows: readonly LegacyBaselineRow[];
    /** Migration version embedded in request IDs; reruns must reuse it. */
    readonly version?: string;
    /** Deterministic batch size; defaults to 1000 changes per tenant batch. */
    readonly maxBatchSize?: number;
    readonly now?: () => number;
  },
): Promise<LegacyBaselineResult> {
  const version = input.version ?? "1";
  const maxBatchSize = input.maxBatchSize ?? LEGACY_BASELINE_MAX_BATCH;
  if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new TypeError("maxBatchSize must be a positive integer");
  }
  const now = input.now ?? (() => Date.now());

  // Deterministic order: tenants by code-unit order, hashes within a tenant
  // in canonical hash order. Only positive counts are baselined.
  const byTenant = new Map<string, Map<string, number>>();
  for (const row of input.rows) {
    if (!Number.isSafeInteger(row.rootRefCount) || row.rootRefCount <= 0) continue;
    let hashes = byTenant.get(row.tenantId);
    if (!hashes) {
      hashes = new Map();
      byTenant.set(row.tenantId, hashes);
    }
    hashes.set(row.hash, row.rootRefCount);
  }
  const tenants = [...byTenant.keys()].sort(compareCodeUnits);

  let batches = 0;
  let finalRevision = 0;
  const statements: D1PreparedStatement[] = [];
  const statementKinds: Array<"event" | "projection"> = [];

  for (const tenantId of tenants) {
    const hashes = [...byTenant.get(tenantId)!.entries()]
      .sort(([a], [b]) => compareCodeUnits(a, b));
    const tenantLocalBatches = chunk(hashes, maxBatchSize);
    for (let ordinal = 0; ordinal < tenantLocalBatches.length; ordinal += 1) {
      finalRevision += 1;
      batches += 1;
      const requestId = `baseline:${version}:${input.stackId}:${tenantId}:${ordinal}`;
      const changes = Object.fromEntries(tenantLocalBatches[ordinal]!) as Record<string, number>;
      const changesJson = canonicalJson(changes);
      const payloadHash = await sha256Hex(changesJson);
      const appliedAt = now();
      statements.push(
        db.prepare(
          "INSERT OR IGNORE INTO cas_root_domain_events (stack_id, ref_domain, revision, tenant_id, request_id, payload_hash, changes_json, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(input.stackId, LEGACY_DOMAIN, finalRevision, tenantId, requestId, payloadHash, changesJson, appliedAt),
      );
      statementKinds.push("event");
      for (const [hash, count] of tenantLocalBatches[ordinal]!) {
        statements.push(
          db.prepare(
            "INSERT OR IGNORE INTO cas_root_domain_refs (stack_id, ref_domain, tenant_id, hash, ref_count) VALUES (?, ?, ?, ?, ?)",
          ).bind(input.stackId, LEGACY_DOMAIN, tenantId, hash, count),
        );
        statementKinds.push("projection");
      }
    }
  }

  let events = 0;
  let projectionRows = 0;
  if (batches > 0) {
    // Advance the reserved domain revision to the deterministic watermark.
    statements.push(
      db.prepare(
        "INSERT INTO cas_root_domain_revisions (stack_id, ref_domain, revision) VALUES (?, ?, ?) ON CONFLICT(stack_id, ref_domain) DO UPDATE SET revision = MAX(revision, excluded.revision)",
      ).bind(input.stackId, LEGACY_DOMAIN, finalRevision),
    );
    // Count ACTUAL insertions: OR IGNORE makes reruns no-ops.
    const results = await db.batch(statements);
    for (let i = 0; i < statementKinds.length; i += 1) {
      const changes = results[i]?.meta.changes ?? 0;
      if (statementKinds[i] === "event") events += changes;
      else projectionRows += changes;
    }
  }

  return { batches, events, projectionRows, finalRevision };
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
