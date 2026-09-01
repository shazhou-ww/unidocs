import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { NodeReadRecord, NodeReadRepository, NodeReadScope } from "@unicas/service";
import { stackCanonicalNodeKey } from "./do-names.js";
import { timeOperation, type TimingSink } from "./timing.js";

/** D1/R2 adapter for cloud-neutral node content and metadata reads. */
export class CloudflareNodeReadRepository implements NodeReadRepository {
  readonly #db: D1Database;
  readonly #bucket: R2Bucket;
  readonly #timing?: TimingSink;

  constructor(db: D1Database, bucket: R2Bucket, timing?: TimingSink) {
    this.#db = db;
    this.#bucket = bucket;
    this.#timing = timing;
  }

  async readNode(scope: NodeReadScope, hash: string): Promise<NodeReadRecord | null> {
    const node = await timeOperation(this.#timing, "cas_d1_node", () => this.#db.prepare(
      "SELECT content_size, content_type, lease_started_at, lease_expires_at, child_ref_count, root_ref_count FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(scope.stackId, scope.tenantId, hash).first<{
      content_size: number;
      content_type: string;
      lease_started_at: number;
      lease_expires_at: number;
      child_ref_count: number;
      root_ref_count: number;
    }>());
    return node === null ? null : {
      contentSize: node.content_size,
      contentType: node.content_type,
      leaseStartedAt: node.lease_started_at,
      leaseExpiresAt: node.lease_expires_at,
      childRefCount: node.child_ref_count,
      rootRefCount: node.root_ref_count,
    };
  }

  async readOrderedRefs(scope: NodeReadScope, hash: string): Promise<readonly string[]> {
    const edges = await timeOperation(this.#timing, "cas_d1_refs", () => this.#db.prepare(
      "SELECT child_hash FROM cas_edges WHERE stack_id = ? AND tenant_id = ? AND parent_hash = ? ORDER BY ordinal ASC",
    ).bind(scope.stackId, scope.tenantId, hash).all<{ child_hash: string }>());
    return edges.results.map((edge) => edge.child_hash);
  }

  async readCanonicalRange(scope: NodeReadScope, hash: string, range: { readonly offset: number; readonly length: number }): Promise<ReadableStream<Uint8Array> | null> {
    const object = await timeOperation(this.#timing, "cas_r2_get", () =>
      this.#bucket.get(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash), { range }));
    if (object === null || object.body === undefined) return null;
    return object.body as unknown as ReadableStream<Uint8Array>;
  }
}
