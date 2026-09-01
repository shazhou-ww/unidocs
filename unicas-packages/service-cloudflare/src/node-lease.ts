import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import { hashToHex } from "@unicas/codec";
import type {
  AdoptedCanonicalNodePlan,
  CanonicalNodeLeaseRecord,
  CanonicalNodeLeaseRepository,
  CanonicalOrphanObject,
  CanonicalUploadReservation,
  NodeLeaseRecord,
  NodeLeaseScope,
  UploadedCanonicalNodeCommit,
} from "@unicas/service";
import { stackCanonicalNodeKey } from "./do-names.js";
import { timeOperation, type TimingSink } from "./timing.js";

/** D1/R2 adapter for node renewal, upload, and canonical orphan adoption. */
export class CloudflareNodeLeaseRepository implements CanonicalNodeLeaseRepository {
  constructor(
    readonly db: D1Database,
    readonly bucket: R2Bucket,
    readonly timing?: TimingSink,
  ) { }

  async readNodeLease(scope: NodeLeaseScope, hash: string): Promise<NodeLeaseRecord | null> {
    const row = await timeOperation(this.timing, "cas_d1_lease", () => this.db.prepare(
      "SELECT lease_started_at, lease_expires_at FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(scope.stackId, scope.tenantId, hash).first<{ lease_started_at: number; lease_expires_at: number }>());
    return row === null ? null : { leaseStartedAt: row.lease_started_at, leaseExpiresAt: row.lease_expires_at };
  }

  async readCanonicalNodeLease(scope: NodeLeaseScope, hash: string): Promise<CanonicalNodeLeaseRecord | null> {
    const row = await timeOperation(this.timing, "cas_d1_lease", () => this.db.prepare(
      "SELECT content_size, content_type, lease_started_at, lease_expires_at FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(scope.stackId, scope.tenantId, hash).first<{
      content_size: number; content_type: string; lease_started_at: number; lease_expires_at: number;
    }>());
    return row === null ? null : {
      contentSize: row.content_size,
      contentType: row.content_type,
      leaseStartedAt: row.lease_started_at,
      leaseExpiresAt: row.lease_expires_at,
    };
  }

  async readNodeRefs(scope: NodeLeaseScope, hash: string): Promise<readonly string[]> {
    const edges = await timeOperation(this.timing, "cas_d1_refs", () => this.db.prepare(
      "SELECT child_hash FROM cas_edges WHERE stack_id = ? AND tenant_id = ? AND parent_hash = ? ORDER BY ordinal ASC",
    ).bind(scope.stackId, scope.tenantId, hash).all<{ child_hash: string }>());
    return edges.results.map((edge) => edge.child_hash);
  }

  async readCanonicalObject(scope: NodeLeaseScope, hash: string): Promise<CanonicalOrphanObject | null> {
    const object = await timeOperation(this.timing, "cas_r2_head", () =>
      this.bucket.head(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash)));
    if (object === null) return null;
    return {
      storedBytes: object.size,
      ...(object.checksums.sha256 === undefined ? {} : { sha256Hex: hashToHex(new Uint8Array(object.checksums.sha256)) }),
    };
  }

  async readCanonicalPrefix(scope: NodeLeaseScope, hash: string, length: number): Promise<ReadableStream<Uint8Array> | null> {
    const object = await timeOperation(this.timing, "cas_r2_prefix", () =>
      this.bucket.get(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash), { range: { offset: 0, length } }));
    if (object === null || object.body === undefined) return null;
    return object.body as unknown as ReadableStream<Uint8Array>;
  }

  async isNodeReady(scope: NodeLeaseScope, hash: string): Promise<boolean> {
    const row = await timeOperation(this.timing, "cas_d1_ready", () => this.db.prepare(
      "SELECT 1 AS found FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(scope.stackId, scope.tenantId, hash).first<{ found: number }>());
    return row !== null && await timeOperation(this.timing, "cas_r2_head", () =>
      this.bucket.head(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash))) !== null;
  }

  async renewNodeLease(scope: NodeLeaseScope, hash: string, lease: NodeLeaseRecord): Promise<void> {
    await timeOperation(this.timing, "cas_d1_renew", () => this.db.prepare(
      "UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(lease.leaseStartedAt, lease.leaseExpiresAt, scope.stackId, scope.tenantId, hash).run());
  }

  async reserveCanonicalUpload(scope: NodeLeaseScope, reservation: CanonicalUploadReservation): Promise<void> {
    await timeOperation(this.timing, "cas_d1_reserve", () => this.db.prepare(
      `INSERT INTO cas_upload_reservations (stack_id, tenant_id, hash, stored_bytes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(stack_id, tenant_id, hash) DO UPDATE SET stored_bytes = excluded.stored_bytes, expires_at = excluded.expires_at`,
    ).bind(scope.stackId, scope.tenantId, reservation.hash, reservation.storedBytes, reservation.createdAt, reservation.expiresAt).run());
  }

  async putCanonicalObject(scope: NodeLeaseScope, hash: string, body: ReadableStream<Uint8Array>): Promise<void> {
    const key = stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash);
    try {
      await timeOperation(this.timing, "cas_r2_put", () => this.bucket.put(
        key,
        body as unknown as Parameters<R2Bucket["put"]>[1],
        { sha256: hash },
      ));
    } catch (error) {
      // The cloud-neutral kernel sanitizes this into a stable client error;
      // keep the platform detail (e.g. R2 checksum failure) in the logs only.
      console.error(`R2 canonical upload failed for ${scope.stackId}/${scope.tenantId}/${hash}`, error);
      throw error;
    }
  }

  async commitUploadedCanonicalNode(scope: NodeLeaseScope, plan: UploadedCanonicalNodeCommit): Promise<void> {
    if (plan.kind === "existing") {
      await timeOperation(this.timing, "cas_d1_commit", () => this.db.batch([
        this.db.prepare("UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?")
          .bind(plan.leaseStartedAt, plan.leaseExpiresAt, scope.stackId, scope.tenantId, plan.hash),
        this.db.prepare("DELETE FROM cas_upload_reservations WHERE stack_id = ? AND tenant_id = ? AND hash = ?")
          .bind(scope.stackId, scope.tenantId, plan.hash),
      ]).then(() => undefined));
      return;
    }
    await this.commitNewNode(scope, plan);
  }

  async commitAdoptedCanonicalNode(scope: NodeLeaseScope, plan: AdoptedCanonicalNodePlan): Promise<void> {
    const reservation = this.db.prepare(
      `INSERT INTO cas_upload_reservations (stack_id, tenant_id, hash, stored_bytes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(stack_id, tenant_id, hash) DO UPDATE SET stored_bytes = excluded.stored_bytes`,
    ).bind(scope.stackId, scope.tenantId, plan.hash, plan.storedBytes, plan.reservationCreatedAt, plan.reservationExpiresAt);
    await this.commitNewNode(scope, { kind: "new", ...plan }, reservation);
  }

  async commitNewNode(
    scope: NodeLeaseScope,
    plan: Extract<UploadedCanonicalNodeCommit, { kind: "new" }>,
    first?: D1PreparedStatement,
  ): Promise<void> {
    const batch: D1PreparedStatement[] = [];
    if (first) batch.push(first);
    batch.push(this.db.prepare(
      `INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(scope.stackId, scope.tenantId, plan.hash, plan.contentSize, plan.contentType, plan.leaseStartedAt, plan.leaseExpiresAt));
    for (let index = 0; index < plan.refs.length; index++) {
      batch.push(
        this.db.prepare("INSERT INTO cas_edges (stack_id, tenant_id, parent_hash, ordinal, child_hash) VALUES (?, ?, ?, ?, ?)")
          .bind(scope.stackId, scope.tenantId, plan.hash, index, plan.refs[index]),
        this.db.prepare("UPDATE cas_nodes SET child_ref_count = child_ref_count + 1 WHERE stack_id = ? AND tenant_id = ? AND hash = ?")
          .bind(scope.stackId, scope.tenantId, plan.refs[index]),
      );
    }
    batch.push(this.db.prepare("DELETE FROM cas_upload_reservations WHERE stack_id = ? AND tenant_id = ? AND hash = ?")
      .bind(scope.stackId, scope.tenantId, plan.hash));
    await timeOperation(this.timing, "cas_d1_commit", () => this.db.batch(batch).then(() => undefined));
  }
}
