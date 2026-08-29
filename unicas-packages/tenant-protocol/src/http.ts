/**
 * Canonical stack-scoped CAS tenant HTTP contracts.
 *
 * Every tenant service route carries `stackId + tenantId`; the tenant
 * matcher never recognizes `/admin` (that plane belongs to
 * `@unicas/admin-protocol`). The retired owner-assignment and
 * portable-node and pre-stack HTTP contracts are removed.
 */

import type {
  CasGcResult,
  CasHash,
  CasLeaseResult,
  CasNodeMetadata,
  CasNodeState,
  CasRootRefUpdate,
  CasUsage,
} from "./types.js";

export const CasRefsHeader = "X-CAS-Refs";
export const CasLeaseDurationHeader = "X-CAS-Lease-Duration";

export interface CasStackPath {
  readonly stackId: string;
}

export interface CasTenantPath extends CasStackPath {
  readonly tenantId: string;
}

export interface CasNodePath extends CasTenantPath {
  readonly hash: CasHash;
}

export interface CasErrorResponse {
  readonly error: string;
}

export interface CasReadContentRequest {
  readonly path: CasNodePath;
}

export type CasReadContentResponse =
  | { body: ReadableStream<Uint8Array>; headers: { contentType: string; contentLength: number } }
  | CasErrorResponse;

export interface CasReadMetadataRequest {
  readonly path: CasNodePath;
}

export type CasReadMetadataResponse =
  | { metadata: CasNodeMetadata; state: CasNodeState }
  | CasErrorResponse;

export interface CasLeaseRequest {
  readonly path: CasNodePath;
  readonly headers: {
    leaseDurationMs?: number;
    contentType?: "application/vnd.unidocs.cas-node.v1";
    contentLength?: number;
  };
  readonly body?: ReadableStream<Uint8Array>;
}

export type CasLeaseResponse = CasLeaseResult | CasErrorResponse;

export interface CasUsageRequest {
  readonly path: CasTenantPath;
}

export type CasUsageResponse = CasUsage | CasErrorResponse;

export interface CasGcRequest {
  readonly path: CasTenantPath;
  readonly body?: { maxNodes?: number };
}

export type CasGcResponse = CasGcResult | CasErrorResponse;

/** Signed Root Refs write. `refDomain` is NOT caller-supplied; it comes only
 *  from the verified tenant capability (Task 4). */
export interface CasUpdateRootRefsRequest {
  readonly path: CasTenantPath;
  readonly body: CasRootRefUpdate;
}

export type CasUpdateRootRefsResponse =
  | { success: true; idempotent: boolean; revision: number }
  | CasErrorResponse;

export interface CasEndpointContracts {
  readContent: { request: CasReadContentRequest; response: CasReadContentResponse };
  readMetadata: { request: CasReadMetadataRequest; response: CasReadMetadataResponse };
  lease: { request: CasLeaseRequest; response: CasLeaseResponse };
  usage: { request: CasUsageRequest; response: CasUsageResponse };
  gc: { request: CasGcRequest; response: CasGcResponse };
  updateRootRefs: {
    request: CasUpdateRootRefsRequest;
    response: CasUpdateRootRefsResponse;
  };
}
