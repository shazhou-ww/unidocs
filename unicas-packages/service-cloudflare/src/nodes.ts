/** Transitional HTTP/Cloudflare facade over cloud-neutral node lease kernels. */
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { CanonicalNodeLimits } from "@unicas/codec";
import { validateHash } from "@unicas/codec";
import type { CasLeaseResult } from "@unicas/tenant-protocol";
export { NodeOpError, NodeOpErrorCodes } from "@unicas/service";
export type { NodeOpErrorCode } from "@unicas/service";
export { clampLeaseDuration, DEFAULT_LEASE_MS, MAX_LEASE_MS, MIN_LEASE_MS, parseLeaseDuration } from "@unicas/service";
import {
  beginCanonicalNodeLease as beginCanonicalNodeLeaseKernel,
  finalizeCanonicalNodeLease as finalizeCanonicalNodeLeaseKernel,
  leaseCanonicalNode as leaseCanonicalNodeKernel,
  leaseReadyNode as leaseReadyNodeKernel,
  NodeOpError,
  NodeOpErrorCodes,
  uploadCanonicalNode as uploadCanonicalNodeKernel,
  type ParsedUploadedNodeMetadata,
} from "@unicas/service";
import type { CanonicalNodeLeaseBeginResult, CanonicalNodeUploadPlan } from "@unicas/service";
import { CloudflareNodeLeaseRepository } from "./node-lease.js";
import type { NodeReadyCache } from "./node-lease.js";
import type { TimingSink } from "./timing.js";

export type { NodeReadyCache } from "./node-lease.js";
export { READY_CACHE_TTL_MS } from "./node-lease.js";

export interface NodeStore {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly stackId: string;
  readonly tenantId: string;
  readonly limits?: CanonicalNodeLimits;
  readonly timing?: TimingSink;
  /** Per-DO positive ready-cache shared by every repository built from this store. */
  readonly readyCache?: NodeReadyCache;
}

export interface LeaseCanonicalNodeInput {
  readonly hash: string;
  readonly leaseDurationMs: number;
  readonly body: ReadableStream<Uint8Array>;
  readonly declaredLength?: number;
}

function repository(store: NodeStore): CloudflareNodeLeaseRepository {
  return new CloudflareNodeLeaseRepository(
    store.db,
    store.bucket,
    store.timing,
    store.readyCache,
  );
}

export function parseRefsHeader(header: string | null): string[] {
  if (!header || header.trim() === "") return [];
  const refs = header.split(",").map((part) => part.trim()).filter(Boolean);
  for (const ref of refs) {
    try {
      validateHash(ref);
    } catch (error) {
      throw new NodeOpError(400, NodeOpErrorCodes.INVALID_REQUEST, error instanceof Error ? error.message : "Invalid child ref");
    }
  }
  return refs;
}

export function leaseCanonicalNode(store: NodeStore, input: LeaseCanonicalNodeInput): Promise<CasLeaseResult> {
  return leaseCanonicalNodeKernel({
    repository: repository(store),
    scope: { stackId: store.stackId, tenantId: store.tenantId },
    ...input,
    limits: store.limits,
  });
}

export function beginCanonicalNodeLease(
  store: NodeStore,
  input: Omit<LeaseCanonicalNodeInput, "body">,
): Promise<CanonicalNodeLeaseBeginResult> {
  return beginCanonicalNodeLeaseKernel({
    repository: repository(store),
    scope: { stackId: store.stackId, tenantId: store.tenantId },
    ...input,
    limits: store.limits,
  });
}

export function uploadCanonicalNode(
  store: NodeStore,
  plan: CanonicalNodeUploadPlan,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  return uploadCanonicalNodeKernel({
    repository: repository(store),
    scope: { stackId: store.stackId, tenantId: store.tenantId },
    plan,
    body,
  });
}

export function finalizeCanonicalNodeLease(
  store: NodeStore,
  plan: CanonicalNodeUploadPlan,
  parsed?: ParsedUploadedNodeMetadata,
): Promise<CasLeaseResult> {
  return finalizeCanonicalNodeLeaseKernel({
    repository: repository(store),
    scope: { stackId: store.stackId, tenantId: store.tenantId },
    plan,
    limits: store.limits,
    ...(parsed === undefined ? {} : { parsed }),
  });
}

export function leaseReadyNode(store: NodeStore, input: { hash: string; leaseDurationMs: number }): Promise<CasLeaseResult> {
  return leaseReadyNodeKernel({
    repository: repository(store),
    scope: { stackId: store.stackId, tenantId: store.tenantId },
    ...input,
    limits: store.limits,
  });
}
