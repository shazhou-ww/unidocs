import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import type {
  NodeGcCandidate,
  NodeGcDeletion,
  NodeGcRepository,
  NodeGcScope,
} from "@unicas/service";
import { stackCanonicalNodeKey } from "./do-names.js";

/** D1/R2 adapter for the cloud-neutral node GC kernel. */
export class CloudflareNodeGcRepository implements NodeGcRepository {
  readonly #db: D1Database;
  readonly #bucket: R2Bucket;

  constructor(db: D1Database, bucket: R2Bucket) {
    this.#db = db;
    this.#bucket = bucket;
  }

  async findExpiredUnreferenced(
    scope: NodeGcScope,
    expiresAtOrBefore: number,
    maxNodes: number,
  ): Promise<readonly NodeGcCandidate[]> {
    const eligible = await this.#db
      .prepare(
        `SELECT hash FROM cas_nodes
         WHERE stack_id = ? AND tenant_id = ?
           AND child_ref_count = 0
           AND root_ref_count = 0
           AND lease_expires_at <= ?
         LIMIT ?`,
      )
      .bind(scope.stackId, scope.tenantId, expiresAtOrBefore, maxNodes)
      .all<{ hash: string }>();
    return eligible.results.map(({ hash }) => ({ hash }));
  }

  async readStillExpiredUnreferenced(
    scope: NodeGcScope,
    hash: string,
    expiresAtOrBefore: number,
  ): Promise<NodeGcDeletion | null> {
    const fresh = await this.#db
      .prepare(
        "SELECT content_size, child_ref_count, root_ref_count, lease_expires_at FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
      )
      .bind(scope.stackId, scope.tenantId, hash)
      .first<{
        content_size: number;
        child_ref_count: number;
        root_ref_count: number;
        lease_expires_at: number;
      }>();
    if (!fresh
      || fresh.child_ref_count > 0
      || fresh.root_ref_count > 0
      || fresh.lease_expires_at > expiresAtOrBefore) {
      return null;
    }
    const edges = await this.#db
      .prepare(
        "SELECT child_hash, COUNT(*) as cnt FROM cas_edges WHERE stack_id = ? AND tenant_id = ? AND parent_hash = ? GROUP BY child_hash",
      )
      .bind(scope.stackId, scope.tenantId, hash)
      .all<{ child_hash: string; cnt: number }>();
    return {
      hash,
      contentSize: fresh.content_size,
      childReferences: edges.results.map((edge) => ({
        hash: edge.child_hash,
        count: edge.cnt,
      })),
    };
  }

  deleteCanonicalContent(scope: NodeGcScope, hash: string): Promise<void> {
    return this.#bucket.delete(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash));
  }

  async commitDeletion(scope: NodeGcScope, deletion: NodeGcDeletion): Promise<void> {
    const batch: D1PreparedStatement[] = [
      this.#db.prepare(
        "DELETE FROM cas_edges WHERE stack_id = ? AND tenant_id = ? AND parent_hash = ?",
      ).bind(scope.stackId, scope.tenantId, deletion.hash),
      this.#db.prepare(
        "DELETE FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
      ).bind(scope.stackId, scope.tenantId, deletion.hash),
    ];
    for (const child of deletion.childReferences) {
      batch.push(
        this.#db.prepare(
          "UPDATE cas_nodes SET child_ref_count = child_ref_count - ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
        ).bind(child.count, scope.stackId, scope.tenantId, child.hash),
      );
    }
    await this.#db.batch(batch);
  }
}
