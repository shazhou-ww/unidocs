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
import {
  computeNodeDigest,
  encodeHeader,
  hashToHex,
  hexToHash,
  validateContentLength,
  validateContentType,
  validateHash,
} from "@unicas/server-common";
import type {
  CasGcResult,
  CasLeaseResult,
  CasNodeMetadata,
  CasNodeState,
  CasUsage,
} from "@unicas/protocol";
import { decodeSValueWithRefs } from "@unidocs/svalue-codec/internal";
import { SValueContentType } from "@unidocs/protocol";
import { stackNodeKey } from "./do-names.js";

/** Default lease duration when the header is absent. */
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
/** Minimum accepted lease duration. */
export const MIN_LEASE_MS = 60 * 1000;
/** Maximum accepted lease duration. */
export const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
/** Default GC batch bound. */
export const DEFAULT_GC_MAX_NODES = 100;

/** Stable storage error carrying an HTTP status and a wire error code. */
export class NodeOpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "NodeOpError";
    this.status = status;
    this.code = code;
  }
}

export const NodeOpErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NODE_NOT_FOUND",
  NOT_READY: "NODE_NOT_READY",
  CONFLICT: "NODE_CONFLICT",
  STORAGE: "STORAGE_ERROR",
} as const;
export type NodeOpErrorCode = (typeof NodeOpErrorCodes)[keyof typeof NodeOpErrorCodes];

/** The stack-scoped stores a tenant DO mutates. */
export interface NodeStore {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly stackId: string;
  readonly tenantId: string;
}

export interface LeaseNodeInput {
  readonly hash: string;
  readonly contentType: string;
  readonly contentLength: number;
  readonly refs: readonly string[];
  readonly leaseDurationMs: number;
  readonly content: Uint8Array;
}

/** Clamp a requested duration into the accepted window. */
export function clampLeaseDuration(value: number): number {
  return Math.min(Math.max(value, MIN_LEASE_MS), MAX_LEASE_MS);
}

/** Parse the X-CAS-Lease-Duration header; defaults when absent or invalid. */
export function parseLeaseDuration(header: string | null): number {
  if (header == null || header === "") return DEFAULT_LEASE_MS;
  const n = Number(header);
  if (!Number.isFinite(n)) {
    throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, "Invalid lease duration");
  }
  return clampLeaseDuration(n);
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

/**
 * Lease a node with content: validate, store the content-addressed bytes, and
 * record the node row plus child edges. Content addressing is authoritative —
 * a mismatched digest, content type, or SValue ref list is rejected before
 * anything is written.
 */
export async function leaseNode(store: NodeStore, input: LeaseNodeInput): Promise<CasLeaseResult> {
  const { db, bucket, stackId, tenantId } = store;
  const { hash, contentType, contentLength, refs, leaseDurationMs, content } = input;
  const now = Date.now();

  try {
    validateHash(hash);
    validateContentType(contentType);
    validateContentLength(content.length, contentLength);
  } catch (err) {
    throw new NodeOpError(
      400,
      NodeOpErrorCodes.INVALID_REQUEST,
      err instanceof Error ? err.message : "Invalid node descriptor",
    );
  }

  if (contentType === SValueContentType) {
    let derivedRefs: readonly string[];
    try {
      derivedRefs = decodeSValueWithRefs(content).refs;
    } catch (err) {
      throw new NodeOpError(
        400,
        NodeOpErrorCodes.INVALID_REQUEST,
        `Invalid SValue content: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!sameRefs(refs, derivedRefs)) {
      throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, "SValue child refs do not match encoded content");
    }
  }

  const existing = await db
    .prepare(
      "SELECT content_size, content_type, lease_started_at, lease_expires_at FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    )
    .bind(stackId, tenantId, hash)
    .first<{ content_size: number; content_type: string; lease_started_at: number; lease_expires_at: number }>();

  // Immutability is checked BEFORE the digest: re-leasing a ready node with
  // different metadata is a 409 CONFLICT (same as the legacy runtime), not a
  // 400 digest error.
  if (existing && !metadataMatches(existing, refs, input)) {
    throw new NodeOpError(409, NodeOpErrorCodes.CONFLICT, "Immutable metadata mismatch");
  }

  const childHashes = refs.map(hexToHash);
  const header = encodeHeader(content.length, contentType, childHashes.length);
  const digest = await computeNodeDigest(header, contentType, childHashes, content);
  const computedHex = hashToHex(digest);
  if (computedHex !== hash) {
    throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, `Digest mismatch: expected ${hash}, got ${computedHex}`);
  }

  for (const childHash of refs) {
    if ((await bucket.head(stackNodeKey(stackId, tenantId, childHash))) === null) {
      throw new NodeOpError(409, NodeOpErrorCodes.NOT_READY, `Child node ${childHash} is not ready`);
    }
  }

  await bucket.put(stackNodeKey(stackId, tenantId, hash), content);

  const leaseStartedAt = existing && existing.lease_expires_at > now ? existing.lease_started_at : now;
  const leaseExpiresAt = now + leaseDurationMs;

  if (existing) {
    await db
      .prepare(
        "UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
      )
      .bind(leaseStartedAt, leaseExpiresAt, stackId, tenantId, hash)
      .run();
  } else {
    const batch: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(stackId, tenantId, hash, content.length, contentType, leaseStartedAt, leaseExpiresAt),
    ];
    for (let i = 0; i < refs.length; i++) {
      batch.push(
        db.prepare(
          "INSERT INTO cas_edges (stack_id, tenant_id, parent_hash, ordinal, child_hash) VALUES (?, ?, ?, ?, ?)",
        ).bind(stackId, tenantId, hash, i, refs[i]),
      );
      batch.push(
        db.prepare(
          "UPDATE cas_nodes SET child_ref_count = child_ref_count + 1 WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
        ).bind(stackId, tenantId, refs[i]),
      );
    }
    await db.batch(batch);
  }

  return { hash, ready: true, leaseStartedAt, leaseExpiresAt };
}

/** Extend the lease on an existing, ready node. */
export async function leaseExisting(
  store: NodeStore,
  input: { hash: string; leaseDurationMs: number },
): Promise<CasLeaseResult> {
  const { db, bucket, stackId, tenantId } = store;
  try {
    validateHash(input.hash);
  } catch (err) {
    throw new NodeOpError(
      400,
      NodeOpErrorCodes.INVALID_REQUEST,
      err instanceof Error ? err.message : "Invalid hash",
    );
  }
  const now = Date.now();
  const existing = await db
    .prepare(
      "SELECT lease_started_at, lease_expires_at FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    )
    .bind(stackId, tenantId, input.hash)
    .first<{ lease_started_at: number; lease_expires_at: number }>();
  if (!existing) {
    throw new NodeOpError(404, NodeOpErrorCodes.NOT_FOUND, `Node ${input.hash} not found`);
  }
  const r2Key = stackNodeKey(stackId, tenantId, input.hash);
  if ((await bucket.head(r2Key)) === null) {
    throw new NodeOpError(409, NodeOpErrorCodes.NOT_READY, `Node ${input.hash} is not ready`);
  }
  const leaseStartedAt = existing.lease_expires_at > now ? existing.lease_started_at : now;
  const leaseExpiresAt = now + input.leaseDurationMs;
  await db
    .prepare(
      "UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    )
    .bind(leaseStartedAt, leaseExpiresAt, stackId, tenantId, input.hash)
    .run();
  return { hash: input.hash, ready: true, leaseStartedAt, leaseExpiresAt };
}

/** Read node content bytes; null when the node or its R2 object is absent. */
export async function readContent(store: NodeStore, hash: string): Promise<Uint8Array | null> {
  const object = await store.bucket.get(stackNodeKey(store.stackId, store.tenantId, hash));
  if (object === null) return null;
  return new Uint8Array(await object.arrayBuffer());
}

/** Read node metadata plus lifecycle state; null when the node is absent. */
export async function readMetadata(
  store: NodeStore,
  hash: string,
): Promise<{ metadata: CasNodeMetadata; state: CasNodeState } | null> {
  const { db, stackId, tenantId } = store;
  const node = await db
    .prepare(
      "SELECT content_size, content_type, lease_started_at, lease_expires_at, child_ref_count, root_ref_count FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    )
    .bind(stackId, tenantId, hash)
    .first<{
      content_size: number;
      content_type: string;
      lease_started_at: number;
      lease_expires_at: number;
      child_ref_count: number;
      root_ref_count: number;
    }>();
  if (!node) return null;
  const edges = await db
    .prepare(
      "SELECT child_hash FROM cas_edges WHERE stack_id = ? AND tenant_id = ? AND parent_hash = ? ORDER BY ordinal ASC",
    )
    .bind(stackId, tenantId, hash)
    .all<{ child_hash: string }>();
  return {
    metadata: {
      hash,
      size: node.content_size,
      contentType: node.content_type,
      refs: edges.results.map((edge) => edge.child_hash),
    },
    state: {
      leaseStartedAt: node.lease_started_at,
      leaseExpiresAt: node.lease_expires_at,
      childRefCount: node.child_ref_count,
      rootRefCount: node.root_ref_count,
    },
  };
}

/** Aggregate storage usage for one (stackId, tenantId). */
export async function usage(store: NodeStore): Promise<CasUsage> {
  const { db, stackId, tenantId } = store;
  const stats = await db
    .prepare(
      `SELECT
        COUNT(*) as nodeCount,
        COALESCE(SUM(content_size), 0) as readyContentBytes,
        COUNT(CASE WHEN lease_expires_at > 0 THEN 1 END) as leasedNodeCount
        FROM cas_nodes WHERE stack_id = ? AND tenant_id = ?`,
    )
    .bind(stackId, tenantId)
    .first<{ nodeCount: number; readyContentBytes: number; leasedNodeCount: number }>();
  const allNodes = await db
    .prepare("SELECT hash FROM cas_nodes WHERE stack_id = ? AND tenant_id = ?")
    .bind(stackId, tenantId)
    .all<{ hash: string }>();
  let notReadyCount = 0;
  for (const node of allNodes.results) {
    if ((await store.bucket.head(stackNodeKey(stackId, tenantId, node.hash))) === null) {
      notReadyCount++;
    }
  }
  return {
    nodeCount: stats?.nodeCount ?? 0,
    readyContentBytes: stats?.readyContentBytes ?? 0,
    notReadyNodeCount: notReadyCount,
    leasedNodeCount: stats?.leasedNodeCount ?? 0,
  };
}

/**
 * Garbage-collect nodes with no child/root references and an expired lease.
 * Examines at most `maxNodes` candidates, re-verifies eligibility inside the
 * tenant DO's serialized context, then deletes the R2 object and the node +
 * edge rows, decrementing children's `child_ref_count`.
 */
export async function triggerGc(store: NodeStore, maxNodes = DEFAULT_GC_MAX_NODES): Promise<CasGcResult> {
  const { db, bucket, stackId, tenantId } = store;
  const now = Date.now();
  const eligible = await db
    .prepare(
      `SELECT hash, content_size FROM cas_nodes
       WHERE stack_id = ? AND tenant_id = ?
         AND child_ref_count = 0
         AND root_ref_count = 0
         AND lease_expires_at <= ?
       LIMIT ?`,
    )
    .bind(stackId, tenantId, now, maxNodes)
    .all<{ hash: string; content_size: number }>();

  let deleted = 0;
  let reclaimedBytes = 0;
  for (const node of eligible.results) {
    const fresh = await db
      .prepare(
        "SELECT child_ref_count, root_ref_count, lease_expires_at FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
      )
      .bind(stackId, tenantId, node.hash)
      .first<{ child_ref_count: number; root_ref_count: number; lease_expires_at: number }>();
    if (!fresh || fresh.child_ref_count > 0 || fresh.root_ref_count > 0 || fresh.lease_expires_at > now) {
      continue;
    }

    const edges = await db
      .prepare(
        "SELECT child_hash, COUNT(*) as cnt FROM cas_edges WHERE stack_id = ? AND tenant_id = ? AND parent_hash = ? GROUP BY child_hash",
      )
      .bind(stackId, tenantId, node.hash)
      .all<{ child_hash: string; cnt: number }>();

    await bucket.delete(stackNodeKey(stackId, tenantId, node.hash));
    const batch: D1PreparedStatement[] = [
      db.prepare("DELETE FROM cas_edges WHERE stack_id = ? AND tenant_id = ? AND parent_hash = ?")
        .bind(stackId, tenantId, node.hash),
      db.prepare("DELETE FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?")
        .bind(stackId, tenantId, node.hash),
    ];
    for (const edge of edges.results) {
      batch.push(
        db.prepare(
          "UPDATE cas_nodes SET child_ref_count = child_ref_count - ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
        ).bind(edge.cnt, stackId, tenantId, edge.child_hash),
      );
    }
    await db.batch(batch);
    deleted++;
    reclaimedBytes += node.content_size;
  }

  return { examined: eligible.results.length, deleted, reclaimedContentBytes: reclaimedBytes };
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

function metadataMatches(
  existing: { content_size: number; content_type: string },
  existingRefs: readonly string[],
  input: LeaseNodeInput,
): boolean {
  return existing.content_size === input.content.length
    && existing.content_type === input.contentType
    && existingRefs.length === input.refs.length
    && existingRefs.every((ref, index) => ref === input.refs[index]);
}
