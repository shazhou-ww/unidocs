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
  CasLeaseOperationResult,
  CasNodeMetadata,
  CasNodeState,
  CasRootRefUpdate,
  CasRootRefsPage,
  CasUsage,
} from "./types.js";

export const CasLeaseDurationHeader = "X-CAS-Lease-Duration";
export const CasUploadLengthHeader = "X-CAS-Upload-Length";
export const CasUploadIdHeader = "X-CAS-Upload-Id";

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
    uploadLength?: number;
    uploadId?: string;
    contentType?: "application/vnd.unidocs.cas-node.v1";
    contentLength?: number;
  };
  readonly body?: ReadableStream<Uint8Array>;
}

export type CasLeaseResponse = CasLeaseOperationResult | CasErrorResponse;

export interface CasUsageRequest {
  readonly path: CasTenantPath;
}

export type CasUsageResponse = CasUsage | CasErrorResponse;

export interface CasGcRequest {
  readonly path: CasTenantPath;
  readonly body?: { maxNodes?: number };
}

export type CasGcResponse = CasGcResult | CasErrorResponse;

export interface CasListRootRefsRequest {
  readonly path: CasTenantPath;
  readonly query?: { readonly limit?: number; readonly cursor?: string };
}

export type CasListRootRefsResponse = CasRootRefsPage | CasErrorResponse;

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
  listRootRefs: { request: CasListRootRefsRequest; response: CasListRootRefsResponse };
  updateRootRefs: {
    request: CasUpdateRootRefsRequest;
    response: CasUpdateRootRefsResponse;
  };
}
