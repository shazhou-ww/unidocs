import type { CanonicalNodeLimits } from "@unicas/codec";
import {
  HASH_SIZE,
  HEADER_SIZE,
  MAX_CANONICAL_NODE_BYTES,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_NODE_REFS,
  parseCanonicalNodeStream,
  validateHash,
} from "@unicas/codec";
import type { CasLeaseResult } from "@unicas/tenant-protocol";
import { NodeOpError, NodeOpErrorCodes } from "./node-errors.js";

export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
export const MIN_LEASE_MS = 60 * 1000;
export const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

export interface NodeLeaseScope {
  readonly stackId: string;
  readonly tenantId: string;
}

export interface NodeLeaseRecord {
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
}

export interface CanonicalOrphanObject {
  readonly storedBytes: number;
  readonly sha256Hex?: string;
}

export interface AdoptedCanonicalNodePlan {
  readonly hash: string;
  readonly contentSize: number;
  readonly contentType: string;
  readonly refs: readonly string[];
  readonly storedBytes: number;
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
  readonly reservationCreatedAt: number;
  readonly reservationExpiresAt: number;
}

/** Semantic persistence boundary for bodyless node renewal and orphan adoption. */
export interface NodeLeaseRepository {
  readNodeLease(scope: NodeLeaseScope, hash: string): Promise<NodeLeaseRecord | null>;
  readCanonicalObject(scope: NodeLeaseScope, hash: string): Promise<CanonicalOrphanObject | null>;
  readCanonicalPrefix(
    scope: NodeLeaseScope,
    hash: string,
    length: number,
  ): Promise<ReadableStream<Uint8Array> | null>;
  isNodeReady(scope: NodeLeaseScope, hash: string): Promise<boolean>;
  renewNodeLease(
    scope: NodeLeaseScope,
    hash: string,
    lease: NodeLeaseRecord,
  ): Promise<void>;
  commitAdoptedCanonicalNode(
    scope: NodeLeaseScope,
    plan: AdoptedCanonicalNodePlan,
  ): Promise<void>;
}

export function clampLeaseDuration(value: number): number {
  return Math.min(Math.max(value, MIN_LEASE_MS), MAX_LEASE_MS);
}

export function parseLeaseDuration(header: string | null): number {
  if (header == null || header === "") return DEFAULT_LEASE_MS;
  const value = Number(header);
  if (!Number.isFinite(value)) {
    throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, "Invalid lease duration");
  }
  return clampLeaseDuration(value);
}

export function nextNodeLease(
  existing: NodeLeaseRecord | null,
  durationMs: number,
  now: number,
): NodeLeaseRecord {
  return {
    leaseStartedAt: existing && existing.leaseExpiresAt > now ? existing.leaseStartedAt : now,
    leaseExpiresAt: Math.max(existing?.leaseExpiresAt ?? 0, now + durationMs),
  };
}

/** Renew an existing ready node, or adopt a verified canonical object without a row. */
export async function leaseReadyNode(input: {
  readonly repository: NodeLeaseRepository;
  readonly scope: NodeLeaseScope;
  readonly hash: string;
  readonly leaseDurationMs: number;
  readonly limits?: CanonicalNodeLimits;
  readonly now?: () => number;
}): Promise<CasLeaseResult> {
  try {
    validateHash(input.hash);
  } catch (error) {
    throw new NodeOpError(
      400,
      NodeOpErrorCodes.INVALID_REQUEST,
      error instanceof Error ? error.message : "Invalid hash",
    );
  }

  const now = (input.now ?? (() => Date.now()))();
  const existing = await input.repository.readNodeLease(input.scope, input.hash);
  if (existing !== null) {
    if (!await input.repository.isNodeReady(input.scope, input.hash)) {
      throw new NodeOpError(
        409,
        NodeOpErrorCodes.NOT_READY,
        `Node ${input.hash} is not ready`,
      );
    }
    const lease = nextNodeLease(existing, input.leaseDurationMs, now);
    await input.repository.renewNodeLease(input.scope, input.hash, lease);
    return { hash: input.hash, ready: true, ...lease };
  }

  const object = await input.repository.readCanonicalObject(input.scope, input.hash);
  if (
    object === null
    || object.storedBytes > (input.limits?.maxCanonicalNodeBytes ?? MAX_CANONICAL_NODE_BYTES)
    || object.sha256Hex !== input.hash
  ) {
    throw new NodeOpError(404, NodeOpErrorCodes.NOT_FOUND, `Node ${input.hash} not found`);
  }

  const prefixLimit = HEADER_SIZE
    + MAX_CONTENT_TYPE_LENGTH
    + (input.limits?.maxNodeRefs ?? MAX_NODE_REFS) * HASH_SIZE;
  let parsed: Awaited<ReturnType<typeof parseCanonicalNodeStream>>;
  try {
    const prefix = await input.repository.readCanonicalPrefix(
      input.scope,
      input.hash,
      Math.min(object.storedBytes, prefixLimit),
    );
    if (prefix === null) throw new Error("Canonical node disappeared during inspection");
    parsed = await parseCanonicalNodeStream(prefix, object.storedBytes, input.limits);
    await parsed.body.cancel("Canonical prefix inspection complete");
  } catch (error) {
    throw new NodeOpError(
      409,
      NodeOpErrorCodes.CONFLICT,
      error instanceof Error ? error.message : "Canonical orphan is invalid",
    );
  }

  for (const childHash of parsed.refs) {
    if (!await input.repository.isNodeReady(input.scope, childHash)) {
      throw new NodeOpError(
        409,
        NodeOpErrorCodes.NOT_READY,
        `Child node ${childHash} is not ready`,
      );
    }
  }

  const lease = nextNodeLease(null, input.leaseDurationMs, now);
  await input.repository.commitAdoptedCanonicalNode(input.scope, {
    hash: input.hash,
    contentSize: parsed.contentSize,
    contentType: parsed.contentType,
    refs: parsed.refs,
    storedBytes: object.storedBytes,
    ...lease,
    reservationCreatedAt: now,
    reservationExpiresAt: now + MAX_LEASE_MS,
  });
  return { hash: input.hash, ready: true, ...lease };
}
