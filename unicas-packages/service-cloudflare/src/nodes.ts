/** Transitional HTTP/Cloudflare facade over cloud-neutral node lease kernels. */
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { CanonicalNodeLimits } from "@unicas/codec";
import { validateHash } from "@unicas/codec";
import type { CasLeaseResult } from "@unicas/tenant-protocol";
export { NodeOpError, NodeOpErrorCodes } from "@unicas/service";
export type { NodeOpErrorCode } from "@unicas/service";
export { clampLeaseDuration, DEFAULT_LEASE_MS, MAX_LEASE_MS, MIN_LEASE_MS, parseLeaseDuration } from "@unicas/service";
import { leaseCanonicalNode as leaseCanonicalNodeKernel, leaseReadyNode as leaseReadyNodeKernel, NodeOpError, NodeOpErrorCodes } from "@unicas/service";
import { CloudflareNodeLeaseRepository } from "./node-lease.js";
import type { TimingSink } from "./timing.js";

export interface NodeStore {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly stackId: string;
  readonly tenantId: string;
  readonly limits?: CanonicalNodeLimits;
  readonly timing?: TimingSink;
}

export interface LeaseCanonicalNodeInput {
  readonly hash: string;
  readonly leaseDurationMs: number;
  readonly body: ReadableStream<Uint8Array>;
  readonly declaredLength?: number;
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
    repository: new CloudflareNodeLeaseRepository(store.db, store.bucket, store.timing),
    scope: { stackId: store.stackId, tenantId: store.tenantId },
    ...input,
    limits: store.limits,
  });
}

export function leaseReadyNode(store: NodeStore, input: { hash: string; leaseDurationMs: number }): Promise<CasLeaseResult> {
  return leaseReadyNodeKernel({
    repository: new CloudflareNodeLeaseRepository(store.db, store.bucket, store.timing),
    scope: { stackId: store.stackId, tenantId: store.tenantId },
    ...input,
    limits: store.limits,
  });
}
