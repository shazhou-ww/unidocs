import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import {
  applyRootRefsUpdate,
  type CanonicalRootRefsUpdate,
  type DomainUpdateResult,
  type RootRefCommitPlan,
  type RootRefDomainState,
  type RootRefNodeState,
  type RootRefRepository,
  type RootRefRequestRecord,
  type RootRefScope,
} from "@unicas/service";
import { stackCanonicalNodeKey } from "./do-names.js";

export {
  canonicalizeRootRefsUpdate,
  parseRootRefsBody,
  RootRefsErrorCodes,
  RootRefsRetryableError,
  RootRefsValidationError,
  withDomainRetry,
} from "@unicas/service";
export type {
  CanonicalRootRefsUpdate,
  DomainRetryOptions,
  DomainUpdateResult,
  RootRefsErrorCode,
} from "@unicas/service";

/** D1/R2 implementation of the cloud-neutral Root Ref repository port. */
export class CloudflareRootRefRepository implements RootRefRepository {
  readonly #db: D1Database;
  readonly #bucket: R2Bucket;

  constructor(db: D1Database, bucket: R2Bucket) {
    this.#db = db;
    this.#bucket = bucket;
  }

  async findRequest(
    scope: RootRefScope,
    requestId: string,
  ): Promise<RootRefRequestRecord | null> {
    const row = await this.#db
      .prepare(
        "SELECT payload_hash, revision FROM cas_root_ref_requests WHERE stack_id = ? AND tenant_id = ? AND ref_domain = ? AND request_id = ?",
      )
      .bind(scope.stackId, scope.tenantId, scope.refDomain, requestId)
      .first<{ payload_hash: string; revision: number }>();
    return row === null
      ? null
      : { payloadHash: row.payload_hash, revision: row.revision };
  }

  async readNodes(
    scope: Pick<RootRefScope, "stackId" | "tenantId">,
    hashes: readonly string[],
  ): Promise<readonly RootRefNodeState[]> {
    const nodes: RootRefNodeState[] = [];
    for (const hash of hashes) {
      const row = await this.#db
        .prepare(
          "SELECT root_ref_count FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
        )
        .bind(scope.stackId, scope.tenantId, hash)
        .first<{ root_ref_count: number }>();
      if (row) nodes.push({ hash, rootRefCount: row.root_ref_count });
    }
    return nodes;
  }

  async findUnreadyNode(
    scope: Pick<RootRefScope, "stackId" | "tenantId">,
    hashes: readonly string[],
  ): Promise<string | null> {
    for (const hash of hashes) {
      const key = stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash);
      if (!(await this.#bucket.head(key))) return hash;
    }
    return null;
  }

  async readDomainState(scope: RootRefScope): Promise<RootRefDomainState> {
    const revisionRow = await this.#db
      .prepare(
        "SELECT revision FROM cas_root_domain_revisions WHERE stack_id = ? AND ref_domain = ?",
      )
      .bind(scope.stackId, scope.refDomain)
      .first<{ revision: number }>();
    const projectionRows = await this.#db
      .prepare(
        "SELECT hash, ref_count FROM cas_root_domain_refs WHERE stack_id = ? AND ref_domain = ? AND tenant_id = ?",
      )
      .bind(scope.stackId, scope.refDomain, scope.tenantId)
      .all<{ hash: string; ref_count: number }>();
    return {
      revision: revisionRow?.revision ?? 0,
      balances: new Map(
        (projectionRows.results ?? []).map((row) => [row.hash, row.ref_count]),
      ),
    };
  }

  async commit(plan: RootRefCommitPlan): Promise<"committed" | "revision-conflict"> {
    const { scope } = plan;
    const batch: D1PreparedStatement[] = [
      this.#db.prepare(
        "INSERT INTO cas_root_domain_revisions (stack_id, ref_domain, revision) VALUES (?, ?, ?) ON CONFLICT(stack_id, ref_domain) DO UPDATE SET revision = excluded.revision WHERE cas_root_domain_revisions.revision = ?",
      ).bind(scope.stackId, scope.refDomain, plan.revision, plan.expectedRevision),
    ];
    for (const [hash, delta] of plan.entries) {
      batch.push(
        this.#db.prepare(
          "UPDATE cas_nodes SET root_ref_count = root_ref_count + ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
        ).bind(delta, scope.stackId, scope.tenantId, hash),
      );
      const projection = plan.projections.find((candidate) => candidate.hash === hash)!;
      if (projection.refCount === null) {
        batch.push(
          this.#db.prepare(
            "DELETE FROM cas_root_domain_refs WHERE stack_id = ? AND ref_domain = ? AND tenant_id = ? AND hash = ?",
          ).bind(scope.stackId, scope.refDomain, scope.tenantId, hash),
        );
      } else {
        batch.push(
          this.#db.prepare(
            "INSERT INTO cas_root_domain_refs (stack_id, ref_domain, tenant_id, hash, ref_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(stack_id, ref_domain, tenant_id, hash) DO UPDATE SET ref_count = excluded.ref_count",
          ).bind(
            scope.stackId,
            scope.refDomain,
            scope.tenantId,
            hash,
            projection.refCount,
          ),
        );
      }
    }
    batch.push(
      this.#db.prepare(
        "INSERT INTO cas_root_domain_events (stack_id, ref_domain, revision, tenant_id, request_id, payload_hash, changes_json, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        scope.stackId,
        scope.refDomain,
        plan.revision,
        scope.tenantId,
        plan.requestId,
        plan.payloadHash,
        plan.changesJson,
        plan.appliedAt,
      ),
    );
    batch.push(
      this.#db.prepare(
        "INSERT INTO cas_root_ref_requests (stack_id, tenant_id, ref_domain, request_id, payload_hash, revision, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        scope.stackId,
        scope.tenantId,
        scope.refDomain,
        plan.requestId,
        plan.payloadHash,
        plan.revision,
        plan.appliedAt,
      ),
    );

    const results = await this.#db.batch(batch);
    return (results[0]?.meta.changes ?? 0) === 1
      ? "committed"
      : "revision-conflict";
  }
}

export async function listTenantRootRefs(input: {
  readonly db: D1Database;
  readonly stackId: string;
  readonly tenantId: string;
  readonly refDomain: string;
  readonly limit: number;
  readonly cursor: string;
}) {
  const revisionRow = await input.db.prepare(
    "SELECT revision FROM cas_root_domain_revisions WHERE stack_id = ? AND ref_domain = ?",
  ).bind(input.stackId, input.refDomain).first<{ revision: number }>();
  const rows = await input.db.prepare(
    `SELECT hash, ref_count FROM cas_root_domain_refs
     WHERE stack_id = ? AND ref_domain = ? AND tenant_id = ? AND hash > ?
     ORDER BY hash LIMIT ?`,
  ).bind(
    input.stackId,
    input.refDomain,
    input.tenantId,
    input.cursor,
    input.limit + 1,
  ).all<{ hash: string; ref_count: number }>();
  const results = rows.results ?? [];
  const items = results.slice(0, input.limit).map((row) => ({
    hash: row.hash,
    refCount: row.ref_count,
  }));
  return {
    refDomain: input.refDomain,
    revision: revisionRow?.revision ?? 0,
    items,
    nextCursor: results.length > input.limit ? items[items.length - 1]!.hash : null,
  };
}

/** Compatibility entry point used by the transitional Cloudflare DO. */
export function executeDomainUpdate(input: {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly stackId: string;
  readonly tenantId: string;
  readonly refDomain: string;
  readonly canonical: CanonicalRootRefsUpdate;
  readonly now?: () => number;
}): Promise<DomainUpdateResult> {
  return applyRootRefsUpdate({
    repository: new CloudflareRootRefRepository(input.db, input.bucket),
    stackId: input.stackId,
    tenantId: input.tenantId,
    refDomain: input.refDomain,
    canonical: input.canonical,
    now: input.now,
  });
}
