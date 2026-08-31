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
  hashToHex,
  hexToHash,
  validateContentLength,
  validateContentType,
  validateHash,
} from "@unicas/codec";
import type {
  CasLeaseResult,
  CasNodeMetadata,
  CasNodeState,
} from "@unicas/tenant-protocol";
import { stackCanonicalNodeKey } from "./do-names.js";

/** Default lease duration when the header is absent. */
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
/** Minimum accepted lease duration. */
export const MIN_LEASE_MS = 60 * 1000;
/** Maximum accepted lease duration. */
export const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

/** Stable storage error carrying an HTTP status and a wire error code. */
export class NodeOpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers?: HeadersInit;

  constructor(status: number, code: string, message: string, headers?: HeadersInit) {
    super(message);
    this.name = "NodeOpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
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
  return {
    leaseStartedAt: existing && existing.lease_expires_at > now ? existing.lease_started_at : now,
    leaseExpiresAt: Math.max(existing?.lease_expires_at ?? 0, now + durationMs),
  };
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
  const existing = await existingNode(store, input.hash);
  if (!existing) {
    const adopted = await adoptCanonicalOrphan(store, input.hash, input.leaseDurationMs);
    if (adopted !== null) return adopted;
    throw new NodeOpError(404, NodeOpErrorCodes.NOT_FOUND, `Node ${input.hash} not found`);
  }
  const r2Key = stackCanonicalNodeKey(stackId, tenantId, input.hash);
  if ((await bucket.head(r2Key)) === null) {
    throw new NodeOpError(409, NodeOpErrorCodes.NOT_READY, `Node ${input.hash} is not ready`);
  }
  const { leaseStartedAt, leaseExpiresAt } = nextLease(existing, input.leaseDurationMs, now);
  await db
    .prepare(
      "UPDATE cas_nodes SET lease_started_at = ?, lease_expires_at = ? WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    )
    .bind(leaseStartedAt, leaseExpiresAt, stackId, tenantId, input.hash)
    .run();
  return { hash: input.hash, ready: true, leaseStartedAt, leaseExpiresAt };
}

async function adoptCanonicalOrphan(
  store: NodeStore,
  hash: string,
  leaseDurationMs: number,
): Promise<CasLeaseResult | null> {
  const key = stackCanonicalNodeKey(store.stackId, store.tenantId, hash);
  const object = await store.bucket.head(key);
  if (
    object === null
    || object.size > (store.limits?.maxCanonicalNodeBytes ?? MAX_CANONICAL_NODE_BYTES)
    || object.checksums.sha256 === undefined
  ) {
    return null;
  }
  if (hashToHex(new Uint8Array(object.checksums.sha256)) !== hash) return null;

  let parsed;
  try {
    parsed = await inspectCanonicalObject(store, key, object.size);
  } catch (error) {
    throw new NodeOpError(
      409,
      NodeOpErrorCodes.CONFLICT,
      error instanceof Error ? error.message : "Canonical orphan is invalid",
    );
  }
  for (const childHash of parsed.refs) {
    if (!await isReady(store, childHash)) {
      throw new NodeOpError(409, NodeOpErrorCodes.NOT_READY, `Child node ${childHash} is not ready`);
    }
  }

  const now = Date.now();
  const lease = nextLease(null, leaseDurationMs, now);
  const batch: D1PreparedStatement[] = [
    store.db.prepare(
      `INSERT INTO cas_upload_reservations (stack_id, tenant_id, hash, stored_bytes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(stack_id, tenant_id, hash) DO UPDATE SET stored_bytes = excluded.stored_bytes`,
    ).bind(store.stackId, store.tenantId, hash, object.size, now, now + MAX_LEASE_MS),
    store.db.prepare(
      `INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      store.stackId,
      store.tenantId,
      hash,
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
      ).bind(store.stackId, store.tenantId, hash, index, parsed.refs[index]),
      store.db.prepare(
        "UPDATE cas_nodes SET child_ref_count = child_ref_count + 1 WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
      ).bind(store.stackId, store.tenantId, parsed.refs[index]),
    );
  }
  batch.push(store.db.prepare(
    "DELETE FROM cas_upload_reservations WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
  ).bind(store.stackId, store.tenantId, hash));
  await store.db.batch(batch);
  return { hash, ready: true, ...lease };
}

export interface NodeContentStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
  readonly contentSize: number;
  readonly range?: { readonly start: number; readonly end: number };
}

function parseContentRange(header: string | null, size: number): { offset: number; length: number } | undefined {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (match[1] === "" && match[2] === "") || size === 0) {
    throw new NodeOpError(416, NodeOpErrorCodes.INVALID_REQUEST, "Range is not satisfiable", {
      "Content-Range": `bytes */${size}`,
    });
  }
  const first = match[1] === "" ? undefined : Number(match[1]);
  const last = match[2] === "" ? undefined : Number(match[2]);
  if (
    (first !== undefined && (!Number.isSafeInteger(first) || first < 0))
    || (last !== undefined && (!Number.isSafeInteger(last) || last < 0))
  ) {
    throw new NodeOpError(416, NodeOpErrorCodes.INVALID_REQUEST, "Range is not satisfiable", {
      "Content-Range": `bytes */${size}`,
    });
  }
  if (first === undefined) {
    if (last === undefined || last === 0) {
      throw new NodeOpError(416, NodeOpErrorCodes.INVALID_REQUEST, "Range is not satisfiable", {
        "Content-Range": `bytes */${size}`,
      });
    }
    const length = Math.min(last, size);
    return { offset: size - length, length };
  }
  if (first >= size || (last !== undefined && last < first)) {
    throw new NodeOpError(416, NodeOpErrorCodes.INVALID_REQUEST, "Range is not satisfiable", {
      "Content-Range": `bytes */${size}`,
    });
  }
  const end = last === undefined ? size - 1 : Math.min(last, size - 1);
  return { offset: first, length: end - first + 1 };
}

/** Open node own-content as an R2 stream; null when the node is absent or not ready. */
export async function readContent(
  store: NodeStore,
  hash: string,
  rangeHeader: string | null = null,
): Promise<NodeContentStream | null> {
  const node = await existingNode(store, hash);
  if (node === null) return null;
  const key = stackCanonicalNodeKey(store.stackId, store.tenantId, hash);
  const requestedRange = parseContentRange(rangeHeader, node.content_size);
  const logicalOffset = requestedRange?.offset ?? 0;
  const logicalLength = requestedRange?.length ?? node.content_size;
  const physicalOffset = 24
    + new TextEncoder().encode(node.content_type).length
    + (await orderedRefs(store, hash)).length * 32;
  const object = await store.bucket.get(key, {
    range: { offset: physicalOffset + logicalOffset, length: logicalLength },
  });
  if (object === null || object.body === undefined) return null;
  return {
    body: object.body as unknown as ReadableStream<Uint8Array>,
    contentType: node.content_type,
    contentSize: node.content_size,
    ...(requestedRange === undefined
      ? {}
      : { range: { start: logicalOffset, end: logicalOffset + logicalLength - 1 } }),
  };
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

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

