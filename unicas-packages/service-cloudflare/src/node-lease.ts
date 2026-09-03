import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import { hashToHex } from "@unicas/codec";
import type {
  AdoptedCanonicalNodePlan,
  CanonicalDirectUploadRepository,
  CanonicalDirectUploadSession,
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

/**
 * Short-lived positive "node is ready" cache keyed by hash, used to avoid an
 * R2 HEAD on every readiness check. Nodes are immutable once committed; only
 * cooperative GC can remove them, and GC deletes the D1 row too, so a row hit
 * plus this cache is a safe readiness signal for everything a live document
 * references. Entries expire quickly so a GC'd row is not masked for long.
 */
export interface NodeReadyCache {
  get(hash: string): number | undefined;
  set(hash: string, expiresAt: number): void;
}

/** Positive ready-cache lifetime. */
export const READY_CACHE_TTL_MS = 60_000;

function cacheExpiry(): number {
  return Date.now() + READY_CACHE_TTL_MS;
}

/** D1/R2 adapter for node renewal, upload, and canonical orphan adoption. */
export class CloudflareNodeLeaseRepository implements CanonicalNodeLeaseRepository, CanonicalDirectUploadRepository {
  constructor(
    readonly db: D1Database,
    readonly bucket: R2Bucket,
    readonly timing?: TimingSink,
    readonly readyCache?: NodeReadyCache,
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
    if (row === null) return false;
    // The D1 row is authoritative liveness (GC deletes it with the object).
    // Skip the R2 HEAD while a recent positive result is cached.
    const cachedUntil = this.readyCache?.get(hash);
    if (cachedUntil !== undefined && cachedUntil >= Date.now()) return true;
    const object = await timeOperation(this.timing, "cas_r2_head", () =>
      this.bucket.head(stackCanonicalNodeKey(scope.stackId, scope.tenantId, hash)));
    if (object !== null) this.readyCache?.set(hash, cacheExpiry());
    return object !== null;
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

  async readCanonicalUploadSession(scope: NodeLeaseScope, hash: string): Promise<CanonicalDirectUploadSession | null> {
    const row = await timeOperation(this.timing, "cas_d1_upload_session", () => this.db.prepare(
      `SELECT upload_id, temporary_object_key, stored_bytes, lease_duration_ms, created_at, expires_at
       FROM cas_direct_upload_sessions WHERE stack_id = ? AND tenant_id = ? AND hash = ?`,
    ).bind(scope.stackId, scope.tenantId, hash).first<{
      upload_id: string;
      temporary_object_key: string;
      stored_bytes: number;
      lease_duration_ms: number;
      created_at: number;
      expires_at: number;
    }>());
    return row === null ? null : {
      hash,
      uploadId: row.upload_id,
      temporaryObjectKey: row.temporary_object_key,
      storedBytes: row.stored_bytes,
      leaseDurationMs: row.lease_duration_ms,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async reserveCanonicalUploadSession(scope: NodeLeaseScope, session: CanonicalDirectUploadSession): Promise<void> {
    await timeOperation(this.timing, "cas_d1_upload_session_reserve", () => this.db.batch([
      this.db.prepare(
        `INSERT INTO cas_direct_upload_sessions
           (stack_id, tenant_id, hash, upload_id, temporary_object_key, stored_bytes, lease_duration_ms, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stack_id, tenant_id, hash) DO UPDATE SET
           upload_id = excluded.upload_id,
           temporary_object_key = excluded.temporary_object_key,
           stored_bytes = excluded.stored_bytes,
           lease_duration_ms = excluded.lease_duration_ms,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      ).bind(
        scope.stackId,
        scope.tenantId,
        session.hash,
        session.uploadId,
        session.temporaryObjectKey,
        session.storedBytes,
        session.leaseDurationMs,
        session.createdAt,
        session.expiresAt,
      ),
      this.db.prepare(
        `INSERT INTO cas_upload_reservations (stack_id, tenant_id, hash, stored_bytes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(stack_id, tenant_id, hash) DO UPDATE SET
           stored_bytes = excluded.stored_bytes,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      ).bind(
        scope.stackId,
        scope.tenantId,
        session.hash,
        session.storedBytes,
        session.createdAt,
        session.expiresAt,
      ),
    ]).then(() => undefined));
  }

  async deleteCanonicalUploadSession(
    scope: NodeLeaseScope,
    hash: string,
    uploadId: string,
  ): Promise<void> {
    await timeOperation(this.timing, "cas_d1_upload_session_delete", () => this.db.batch([
      this.db.prepare(
        `DELETE FROM cas_upload_reservations
         WHERE stack_id = ? AND tenant_id = ? AND hash = ?
           AND EXISTS (
             SELECT 1 FROM cas_direct_upload_sessions
             WHERE stack_id = ? AND tenant_id = ? AND hash = ? AND upload_id = ?
           )`,
      ).bind(scope.stackId, scope.tenantId, hash, scope.stackId, scope.tenantId, hash, uploadId),
      this.db.prepare(
        "DELETE FROM cas_direct_upload_sessions WHERE stack_id = ? AND tenant_id = ? AND hash = ? AND upload_id = ?",
      ).bind(scope.stackId, scope.tenantId, hash, uploadId),
    ]).then(() => undefined));
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
        this.db.prepare("DELETE FROM cas_direct_upload_sessions WHERE stack_id = ? AND tenant_id = ? AND hash = ?")
          .bind(scope.stackId, scope.tenantId, plan.hash),
      ]).then(() => undefined));
      this.readyCache?.set(plan.hash, cacheExpiry());
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
    batch.push(this.db.prepare("DELETE FROM cas_direct_upload_sessions WHERE stack_id = ? AND tenant_id = ? AND hash = ?")
      .bind(scope.stackId, scope.tenantId, plan.hash));
    await timeOperation(this.timing, "cas_d1_commit", () => this.db.batch(batch).then(() => undefined));
    // The node was uploaded by this same DO and the D1 row is now committed;
    // mark it ready so later child checks in the same flow skip the R2 HEAD.
    this.readyCache?.set(plan.hash, cacheExpiry());
    for (const child of plan.refs) this.readyCache?.set(child, cacheExpiry());
  }
}
