/**
 * Canonical stack-scoped CAS tenant HTTP contracts.
 *
 * Every tenant service route carries `stackId + tenantId`; the tenant
 * matcher never recognizes `/admin` (that plane belongs to
 * `@unidocs/protocol-cas-admin`). The retired owner-assignment and
 * portable-node HTTP contracts are removed; the legacy surface is
 * quarantined in `@unidocs/protocol-cas-legacy` until the rollback window
 * closes.
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
  | { body: Uint8Array; headers: { contentType: string } }
  | CasErrorResponse;

export interface CasReadMetadataRequest {
  readonly path: CasNodePath;
}

export type CasReadMetadataResponse =
  | { metadata: CasNodeMetadata; state: CasNodeState }
  | CasErrorResponse;

export interface CasLeaseNodeRequest {
  readonly path: CasNodePath;
  readonly headers: {
    contentType: string;
    contentLength: number;
    refs?: CasHash[];
    leaseDurationMs?: number;
  };
  readonly body: Uint8Array;
}

export type CasLeaseNodeResponse = CasLeaseResult | CasErrorResponse;

export interface CasLeaseExistingRequest {
  readonly path: CasNodePath;
  readonly headers: { leaseDurationMs?: number };
}

export type CasLeaseExistingResponse = CasLeaseResult | CasErrorResponse;

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
  leaseNode: { request: CasLeaseNodeRequest; response: CasLeaseNodeResponse };
  leaseExisting: { request: CasLeaseExistingRequest; response: CasLeaseExistingResponse };
  usage: { request: CasUsageRequest; response: CasUsageResponse };
  gc: { request: CasGcRequest; response: CasGcResponse };
  updateRootRefs: {
    request: CasUpdateRootRefsRequest;
    response: CasUpdateRootRefsResponse;
  };
}
