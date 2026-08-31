/**
 * Stack-scoped node storage operations for the canonical CAS server.
 *
 * Every row and R2 object is keyed by `(stackId, tenantId)` so two stacks
 * sharing a textual tenant id never share nodes, edges, leases, usage, or GC.
 * The Durable Object is the concurrency boundary (one tenant DO serializes
 * leases, GC, and Root Refs commands); these functions are the storage body
 * it calls. Validation mirrors the legacy runtime's content-addressed kernel:
 * hash format, content length, SValue child-ref agreement, digest equality,
 * and immutable metadata on re-lease.
 */

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { CanonicalNodeLimits } from "@unicas/codec";
import {
  HASH_SIZE,
  HEADER_SIZE,
  MAX_CANONICAL_NODE_BYTES,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_NODE_REFS,
  parseCanonicalNodeStream,
  computeNodeDigest,
  encodeHeader,
  hexToHash,
  validateContentLength,
  validateContentType,
  validateHash,
} from "@unicas/codec";
import type {
  CasLeaseResult,
} from "@unicas/tenant-protocol";
export { NodeOpError, NodeOpErrorCodes } from "@unicas/service";
export type { NodeOpErrorCode } from "@unicas/service";
export {
  clampLeaseDuration,
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  MIN_LEASE_MS,
  parseLeaseDuration,
} from "@unicas/service";
import {
  leaseReadyNode as leaseReadyNodeKernel,
  MAX_LEASE_MS,
  nextNodeLease,
  NodeOpError,
  NodeOpErrorCodes,
} from "@unicas/service";
import { stackCanonicalNodeKey } from "./do-names.js";
import { CloudflareNodeLeaseRepository } from "./node-lease.js";


/** The stack-scoped stores a tenant DO mutates. */
export interface NodeStore {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly stackId: string;
  readonly tenantId: string;
  readonly limits?: CanonicalNodeLimits;
}

export interface LeaseCanonicalNodeInput {
  readonly hash: string;
  readonly leaseDurationMs: number;
  readonly body: ReadableStream<Uint8Array>;
  readonly declaredLength?: number;
}

interface StoredNodeRow {
  readonly content_size: number;
  readonly content_type: string;
  readonly lease_started_at: number;
  readonly lease_expires_at: number;
}

async function existingNode(store: NodeStore, hash: string): Promise<StoredNodeRow | null> {
  return store.db
    .prepare(
      "SELECT content_size, content_type, lease_started_at, lease_expires_at FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    )
    .bind(store.stackId, store.tenantId, hash)
    .first<StoredNodeRow>();
}

async function orderedRefs(store: NodeStore, hash: string): Promise<string[]> {
  const edges = await store.db
    .prepare(
      "SELECT child_hash FROM cas_edges WHERE stack_id = ? AND tenant_id = ? AND parent_hash = ? ORDER BY ordinal ASC",
    )
    .bind(store.stackId, store.tenantId, hash)
    .all<{ child_hash: string }>();
  return edges.results.map(edge => edge.child_hash);
}

async function isReady(store: NodeStore, hash: string): Promise<boolean> {
  const node = await existingNode(store, hash);
  return node !== null
    && await store.bucket.head(stackCanonicalNodeKey(store.stackId, store.tenantId, hash)) !== null;
}

function nextLease(
  existing: Pick<StoredNodeRow, "lease_started_at" | "lease_expires_at"> | null,
  durationMs: number,
  now: number,
): { leaseStartedAt: number; leaseExpiresAt: number } {
  return nextNodeLease(existing === null ? null : {
    leaseStartedAt: existing.lease_started_at,
    leaseExpiresAt: existing.lease_expires_at,
  }, durationMs, now);
}

async function discardCanonicalUpload(store: NodeStore, hash: string): Promise<void> {
  await Promise.all([
    store.bucket.delete(stackCanonicalNodeKey(store.stackId, store.tenantId, hash)),
    store.db.prepare(
      "DELETE FROM cas_upload_reservations WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(store.stackId, store.tenantId, hash).run(),
  ]);
}

async function inspectCanonicalObject(
  store: NodeStore,
  key: string,
  canonicalSize: number,
): Promise<Awaited<ReturnType<typeof parseCanonicalNodeStream>>> {
  const prefixLimit = HEADER_SIZE
    + MAX_CONTENT_TYPE_LENGTH
    + (store.limits?.maxNodeRefs ?? MAX_NODE_REFS) * HASH_SIZE;
  const object = await store.bucket.get(key, {
    range: { offset: 0, length: Math.min(canonicalSize, prefixLimit) },
  });
  if (object === null || object.body === undefined) {
    throw new Error("Canonical node disappeared during inspection");
  }
  const parsed = await parseCanonicalNodeStream(
    object.body as unknown as ReadableStream<Uint8Array>,
    canonicalSize,
    store.limits,
  );
  await parsed.body.cancel("Canonical prefix inspection complete");
  return parsed;
}

/** Parse and validate the comma-separated X-CAS-Refs header. */
export function parseRefsHeader(header: string | null): string[] {
  if (!header || header.trim() === "") return [];
  const refs = header.split(",").map((part) => part.trim()).filter(Boolean);
  for (const ref of refs) {
    try {
      validateHash(ref);
    } catch (err) {
      throw new NodeOpError(
        400,
        NodeOpErrorCodes.INVALID_REQUEST,
        err instanceof Error ? err.message : "Invalid child ref",
      );
    }
  }
  return refs;
}

/** Store a complete canonical node stream and establish its lease. */
export async function leaseCanonicalNode(
  store: NodeStore,
  input: LeaseCanonicalNodeInput,
): Promise<CasLeaseResult> {
  try {
    validateHash(input.hash);
  } catch (error) {
    throw new NodeOpError(
      400,
      NodeOpErrorCodes.INVALID_REQUEST,
      error instanceof Error ? error.message : "Invalid hash",
    );
  }

  const existing = await existingNode(store, input.hash);
  if (existing && await store.bucket.head(stackCanonicalNodeKey(store.stackId, store.tenantId, input.hash)) !== null) {
    await input.body.cancel("Node is already ready");
    const lease = nextLease(existing, input.leaseDurationMs, Date.now());
    await store.db.prepare(
      "UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(lease.leaseStartedAt, lease.leaseExpiresAt, store.stackId, store.tenantId, input.hash).run();
    return { hash: input.hash, ready: true, ...lease };
  }

  if (input.declaredLength === undefined) {
    await input.body.cancel("Content-Length is required");
    throw new NodeOpError(411, NodeOpErrorCodes.INVALID_REQUEST, "Content-Length is required");
  }
  if (input.declaredLength > (store.limits?.maxCanonicalNodeBytes ?? MAX_CANONICAL_NODE_BYTES)) {
    await input.body.cancel("Canonical node is too large");
    throw new NodeOpError(413, NodeOpErrorCodes.INVALID_REQUEST, "Canonical node is too large");
  }

  const now = Date.now();
  await store.db.prepare(
    `INSERT INTO cas_upload_reservations (stack_id, tenant_id, hash, stored_bytes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(stack_id, tenant_id, hash) DO UPDATE SET
       stored_bytes = excluded.stored_bytes,
       expires_at = excluded.expires_at`,
  ).bind(
    store.stackId,
    store.tenantId,
    input.hash,
    input.declaredLength,
    now,
    now + MAX_LEASE_MS,
  ).run();

  const canonicalKey = stackCanonicalNodeKey(store.stackId, store.tenantId, input.hash);
  try {
    await store.bucket.put(
      canonicalKey,
      input.body as unknown as Parameters<R2Bucket["put"]>[1],
      { sha256: input.hash },
    );
  } catch (error) {
    await discardCanonicalUpload(store, input.hash);
    throw new NodeOpError(
      400,
      NodeOpErrorCodes.INVALID_REQUEST,
      error instanceof Error ? error.message : "Canonical node upload failed",
    );
  }

  let parsed;
  try {
    parsed = await inspectCanonicalObject(store, canonicalKey, input.declaredLength);
  } catch (error) {
    await discardCanonicalUpload(store, input.hash);
    const message = error instanceof Error ? error.message : "Invalid canonical node";
    throw new NodeOpError(
      message.includes("too large") ? 413 : 400,
      NodeOpErrorCodes.INVALID_REQUEST,
      message,
    );
  }

  if (existing) {
    const refs = await orderedRefs(store, input.hash);
    if (
      existing.content_size !== parsed.contentSize
      || existing.content_type !== parsed.contentType
      || !sameRefs(refs, parsed.refs)
    ) {
      await discardCanonicalUpload(store, input.hash);
      throw new NodeOpError(409, NodeOpErrorCodes.CONFLICT, "Immutable metadata mismatch");
    }
  }

  for (const childHash of parsed.refs) {
    if (!await isReady(store, childHash)) {
      await discardCanonicalUpload(store, input.hash);
      throw new NodeOpError(409, NodeOpErrorCodes.NOT_READY, `Child node ${childHash} is not ready`);
    }
  }

  const lease = nextLease(existing, input.leaseDurationMs, now);
  if (existing) {
    await store.db.batch([
      store.db.prepare(
        "UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
      ).bind(lease.leaseStartedAt, lease.leaseExpiresAt, store.stackId, store.tenantId, input.hash),
      store.db.prepare(
        "DELETE FROM cas_upload_reservations WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
      ).bind(store.stackId, store.tenantId, input.hash),
    ]);
  } else {
    const batch: D1PreparedStatement[] = [
      store.db.prepare(
        `INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        store.stackId,
        store.tenantId,
        input.hash,
        parsed.contentSize,
        parsed.contentType,
        lease.leaseStartedAt,
        lease.leaseExpiresAt,
      ),
    ];
    for (let index = 0; index < parsed.refs.length; index++) {
      batch.push(
        store.db.prepare(
          "INSERT INTO cas_edges (stack_id, tenant_id, parent_hash, ordinal, child_hash) VALUES (?, ?, ?, ?, ?)",
        ).bind(store.stackId, store.tenantId, input.hash, index, parsed.refs[index]),
        store.db.prepare(
          "UPDATE cas_nodes SET child_ref_count = child_ref_count + 1 WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
        ).bind(store.stackId, store.tenantId, parsed.refs[index]),
      );
    }
    batch.push(store.db.prepare(
      "DELETE FROM cas_upload_reservations WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(store.stackId, store.tenantId, input.hash));
    await store.db.batch(batch);
  }

  return { hash: input.hash, ready: true, ...lease };
}

/** Extend the lease on an existing, ready node. */
export async function leaseReadyNode(
  store: NodeStore,
  input: { hash: string; leaseDurationMs: number },
): Promise<CasLeaseResult> {
  return leaseReadyNodeKernel({
    repository: new CloudflareNodeLeaseRepository(store.db, store.bucket),
    scope: { stackId: store.stackId, tenantId: store.tenantId },
    hash: input.hash,
    leaseDurationMs: input.leaseDurationMs,
    limits: store.limits,
  });
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

