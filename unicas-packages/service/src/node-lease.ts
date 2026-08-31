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

export interface CanonicalNodeLeaseRecord extends NodeLeaseRecord {
  readonly contentSize: number;
  readonly contentType: string;
}

export interface CanonicalUploadReservation {
  readonly hash: string;
  readonly storedBytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type UploadedCanonicalNodeCommit =
  | {
    readonly kind: "existing";
    readonly hash: string;
    readonly leaseStartedAt: number;
    readonly leaseExpiresAt: number;
  }
  | {
    readonly kind: "new";
    readonly hash: string;
    readonly contentSize: number;
    readonly contentType: string;
    readonly refs: readonly string[];
    readonly leaseStartedAt: number;
    readonly leaseExpiresAt: number;
  };

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

/** Additional persistence operations required by streaming canonical uploads. */
export interface CanonicalNodeLeaseRepository extends NodeLeaseRepository {
  readCanonicalNodeLease(
    scope: NodeLeaseScope,
    hash: string,
  ): Promise<CanonicalNodeLeaseRecord | null>;
  readNodeRefs(scope: NodeLeaseScope, hash: string): Promise<readonly string[]>;
  reserveCanonicalUpload(
    scope: NodeLeaseScope,
    reservation: CanonicalUploadReservation,
  ): Promise<void>;
  putCanonicalObject(
    scope: NodeLeaseScope,
    hash: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<void>;
  discardCanonicalUpload(scope: NodeLeaseScope, hash: string): Promise<void>;
  commitUploadedCanonicalNode(
    scope: NodeLeaseScope,
    plan: UploadedCanonicalNodeCommit,
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

/** Stream a canonical node to storage, validate its stored envelope, and establish its lease. */
export async function leaseCanonicalNode(input: {
  readonly repository: CanonicalNodeLeaseRepository;
  readonly scope: NodeLeaseScope;
  readonly hash: string;
  readonly leaseDurationMs: number;
  readonly body: ReadableStream<Uint8Array>;
  readonly declaredLength?: number;
  readonly limits?: CanonicalNodeLimits;
  readonly now?: () => number;
}): Promise<CasLeaseResult> {
  validateLeaseHash(input.hash);
  const existing = await input.repository.readCanonicalNodeLease(input.scope, input.hash);
  if (existing !== null && await input.repository.isNodeReady(input.scope, input.hash)) {
    await input.body.cancel("Node is already ready");
    const lease = nextNodeLease(existing, input.leaseDurationMs, (input.now ?? (() => Date.now()))());
    await input.repository.renewNodeLease(input.scope, input.hash, lease);
    return { hash: input.hash, ready: true, ...lease };
  }

  if (input.declaredLength === undefined) {
    await input.body.cancel("Content-Length is required");
    throw new NodeOpError(411, NodeOpErrorCodes.INVALID_REQUEST, "Content-Length is required");
  }
  if (input.declaredLength > (input.limits?.maxCanonicalNodeBytes ?? MAX_CANONICAL_NODE_BYTES)) {
    await input.body.cancel("Canonical node is too large");
    throw new NodeOpError(413, NodeOpErrorCodes.INVALID_REQUEST, "Canonical node is too large");
  }

  const now = (input.now ?? (() => Date.now()))();
  await input.repository.reserveCanonicalUpload(input.scope, {
    hash: input.hash,
    storedBytes: input.declaredLength,
    createdAt: now,
    expiresAt: now + MAX_LEASE_MS,
  });
  try {
    await input.repository.putCanonicalObject(input.scope, input.hash, input.body);
  } catch (error) {
    await input.repository.discardCanonicalUpload(input.scope, input.hash);
    throw new NodeOpError(
      400,
      NodeOpErrorCodes.INVALID_REQUEST,
      isChecksumMismatch(error)
        ? "Canonical node checksum does not match its hash"
        : "Canonical node upload failed",
    );
  }

  let parsed: Awaited<ReturnType<typeof parseCanonicalNodeStream>>;
  try {
    parsed = await inspectCanonicalNode(
      input.repository,
      input.scope,
      input.hash,
      input.declaredLength,
      input.limits,
    );
  } catch (error) {
    await input.repository.discardCanonicalUpload(input.scope, input.hash);
    const message = error instanceof Error ? error.message : "Invalid canonical node";
    throw new NodeOpError(
      message.includes("too large") ? 413 : 400,
      NodeOpErrorCodes.INVALID_REQUEST,
      message,
    );
  }

  if (existing !== null) {
    const refs = await input.repository.readNodeRefs(input.scope, input.hash);
    if (
      existing.contentSize !== parsed.contentSize
      || existing.contentType !== parsed.contentType
      || !sameRefs(refs, parsed.refs)
    ) {
      await input.repository.discardCanonicalUpload(input.scope, input.hash);
      throw new NodeOpError(409, NodeOpErrorCodes.CONFLICT, "Immutable metadata mismatch");
    }
  }

  for (const childHash of parsed.refs) {
    if (!await input.repository.isNodeReady(input.scope, childHash)) {
      await input.repository.discardCanonicalUpload(input.scope, input.hash);
      throw new NodeOpError(
        409,
        NodeOpErrorCodes.NOT_READY,
        `Child node ${childHash} is not ready`,
      );
    }
  }

  const lease = nextNodeLease(existing, input.leaseDurationMs, now);
  await input.repository.commitUploadedCanonicalNode(input.scope, existing === null ? {
    kind: "new",
    hash: input.hash,
    contentSize: parsed.contentSize,
    contentType: parsed.contentType,
    refs: parsed.refs,
    ...lease,
  } : {
    kind: "existing",
    hash: input.hash,
    ...lease,
  });
  return { hash: input.hash, ready: true, ...lease };
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
  validateLeaseHash(input.hash);

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

  let parsed: Awaited<ReturnType<typeof parseCanonicalNodeStream>>;
  try {
    parsed = await inspectCanonicalNode(
      input.repository,
      input.scope,
      input.hash,
      object.storedBytes,
      input.limits,
    );
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

async function inspectCanonicalNode(
  repository: NodeLeaseRepository,
  scope: NodeLeaseScope,
  hash: string,
  storedBytes: number,
  limits?: CanonicalNodeLimits,
): Promise<Awaited<ReturnType<typeof parseCanonicalNodeStream>>> {
  const prefixLimit = HEADER_SIZE
    + MAX_CONTENT_TYPE_LENGTH
    + (limits?.maxNodeRefs ?? MAX_NODE_REFS) * HASH_SIZE;
  const prefix = await repository.readCanonicalPrefix(
    scope,
    hash,
    Math.min(storedBytes, prefixLimit),
  );
  if (prefix === null) throw new Error("Canonical node disappeared during inspection");
  const parsed = await parseCanonicalNodeStream(prefix, storedBytes, limits);
  await parsed.body.cancel("Canonical prefix inspection complete");
  return parsed;
}

function validateLeaseHash(hash: string): void {
  try {
    validateHash(hash);
  } catch (error) {
    throw new NodeOpError(
      400,
      NodeOpErrorCodes.INVALID_REQUEST,
      error instanceof Error ? error.message : "Invalid hash",
    );
  }
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

/** R2 reports checksum mismatches when the uploaded bytes do not hash to the
 *  requested sha256. Recognize it without leaking platform error text. */
function isChecksumMismatch(error: unknown): boolean {
  return error instanceof Error
    && /checksum/i.test(error.message)
    && /did not match|mismatch/i.test(error.message);
}
