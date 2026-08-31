import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import type {
  AdoptedCanonicalNodePlan,
  CanonicalOrphanObject,
  NodeLeaseRecord,
  NodeLeaseRepository,
  NodeLeaseScope,
} from "@unicas/service";
import { hashToHex } from "@unicas/codec";
import { stackCanonicalNodeKey } from "./do-names.js";

/** D1/R2 adapter for bodyless node renewal and canonical orphan adoption. */
export class CloudflareNodeLeaseRepository implements NodeLeaseRepository {
  readonly #db: D1Database;
  readonly #bucket: R2Bucket;

  constructor(db: D1Database, bucket: R2Bucket) {
    this.#db = db;
    this.#bucket = bucket;
  }

  async readNodeLease(scope: NodeLeaseScope, hash: string): Promise<NodeLeaseRecord | null> {
    const row = await this.#db.prepare(
      "SELECT lease_started_at, lease_expires_at FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(scope.stackId, scope.tenantId, hash).first<{
      lease_started_at: number;
      lease_expires_at: number;
    }>();
    return row === null ? null : {
      leaseStartedAt: row.lease_started_at,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  async readCanonicalObject(
    scope: NodeLeaseScope,
    hash: string,
  ): Promise<CanonicalOrphanObject | null> {
    const object = await this.#bucket.head(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash));
    if (object === null) return null;
    return {
      storedBytes: object.size,
      ...(object.checksums.sha256 === undefined
        ? {}
        : { sha256Hex: hashToHex(new Uint8Array(object.checksums.sha256)) }),
    };
  }

  async readCanonicalPrefix(
    scope: NodeLeaseScope,
    hash: string,
    length: number,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const object = await this.#bucket.get(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash), {
      range: { offset: 0, length },
    });
    if (object === null || object.body === undefined) return null;
    return object.body as unknown as ReadableStream<Uint8Array>;
  }

  async isNodeReady(scope: NodeLeaseScope, hash: string): Promise<boolean> {
    const row = await this.#db.prepare(
      "SELECT 1 AS found FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(scope.stackId, scope.tenantId, hash).first<{ found: number }>();
    return row !== null
      && await this.#bucket.head(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash)) !== null;
  }

  async renewNodeLease(
    scope: NodeLeaseScope,
    hash: string,
    lease: NodeLeaseRecord,
  ): Promise<void> {
    await this.#db.prepare(
      "UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(
      lease.leaseStartedAt,
      lease.leaseExpiresAt,
      scope.stackId,
      scope.tenantId,
      hash,
    ).run();
  }

  async commitAdoptedCanonicalNode(
    scope: NodeLeaseScope,
    plan: AdoptedCanonicalNodePlan,
  ): Promise<void> {
    const batch: D1PreparedStatement[] = [
      this.#db.prepare(
        `INSERT INTO cas_upload_reservations (stack_id, tenant_id, hash, stored_bytes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(stack_id, tenant_id, hash) DO UPDATE SET stored_bytes = excluded.stored_bytes`,
      ).bind(
        scope.stackId,
        scope.tenantId,
        plan.hash,
        plan.storedBytes,
        plan.reservationCreatedAt,
        plan.reservationExpiresAt,
      ),
      this.#db.prepare(
        `INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        scope.stackId,
        scope.tenantId,
        plan.hash,
        plan.contentSize,
        plan.contentType,
        plan.leaseStartedAt,
        plan.leaseExpiresAt,
      ),
    ];
    for (let index = 0; index < plan.refs.length; index++) {
      batch.push(
        this.#db.prepare(
          "INSERT INTO cas_edges (stack_id, tenant_id, parent_hash, ordinal, child_hash) VALUES (?, ?, ?, ?, ?)",
        ).bind(scope.stackId, scope.tenantId, plan.hash, index, plan.refs[index]),
        this.#db.prepare(
          "UPDATE cas_nodes SET child_ref_count = child_ref_count + 1 WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
        ).bind(scope.stackId, scope.tenantId, plan.refs[index]),
      );
    }
    batch.push(this.#db.prepare(
      "DELETE FROM cas_upload_reservations WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(scope.stackId, scope.tenantId, plan.hash));
    await this.#db.batch(batch);
  }
}
