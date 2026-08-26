/**
 * MIGRATION-ONLY legacy package — see ./types.ts header. Verbatim snapshot of
 * the tenant-scoped CAS HTTP contracts.
 */

import type {
  CasAssignRootsRequest,
  CasGcResult,
  CasHash,
  CasLeaseResult,
  CasNodeMetadata,
  CasNodeState,
  CasRootRefUpdate,
  CasUsage,
} from "./types.js";

export const CasPortableNodeContentType = "application/vnd.unidocs.cas-node";
export const CasRefsHeader = "X-CAS-Refs";
export const CasLeaseDurationHeader = "X-CAS-Lease-Duration";

export interface CasNodePath {
  tenantId: string;
  hash: CasHash;
}

export interface CasTenantPath {
  tenantId: string;
}

export interface CasErrorResponse {
  error: string;
}

export interface CasReadContentRequest {
  path: CasNodePath;
}

export type CasReadContentResponse =
  | { body: Uint8Array; headers: { contentType: string } }
  | CasErrorResponse;

export interface CasReadMetadataRequest {
  path: CasNodePath;
}

export type CasReadMetadataResponse =
  | { metadata: CasNodeMetadata; state: CasNodeState }
  | CasErrorResponse;

export interface CasLeaseNodeRequest {
  path: CasNodePath;
  headers: {
    contentType: string;
    contentLength: number;
    refs?: CasHash[];
    leaseDurationMs?: number;
  };
  body: Uint8Array;
}

export type CasLeaseNodeResponse = CasLeaseResult | CasErrorResponse;

export interface CasLeaseExistingRequest {
  path: CasNodePath;
  headers: { leaseDurationMs?: number };
}

export type CasLeaseExistingResponse = CasLeaseResult | CasErrorResponse;

export interface CasUsageRequest {
  path: CasTenantPath;
}

export type CasUsageResponse = CasUsage | CasErrorResponse;

export interface CasGcRequest {
  path: CasTenantPath;
  body?: { maxNodes?: number };
}

export type CasGcResponse = CasGcResult | CasErrorResponse;

export interface CasRootRefsRequest {
  path: CasTenantPath;
  body: CasRootRefUpdate;
}

export type CasRootRefsResponse =
  | { success: true; idempotent?: true }
  | CasErrorResponse;

export interface CasRootAssignmentsRequest {
  path: CasTenantPath;
  body: CasAssignRootsRequest;
}

export type CasRootAssignmentsResponse =
  | { success: true; idempotent: boolean }
  | CasErrorResponse;

export interface CasReadPortableNodeRequest {
  path: CasNodePath;
}

export type CasReadPortableNodeResponse =
  | {
    body: Uint8Array;
    headers: { contentType: typeof CasPortableNodeContentType };
  }
  | CasErrorResponse;

export interface CasLeasePortableNodeRequest {
  path: CasNodePath;
  headers: { leaseDurationMs?: number };
  body: Uint8Array;
}

export type CasLeasePortableNodeResponse = CasLeaseResult | CasErrorResponse;

export interface CasEndpointContracts {
  readContent: { request: CasReadContentRequest; response: CasReadContentResponse };
  readMetadata: { request: CasReadMetadataRequest; response: CasReadMetadataResponse };
  leaseNode: { request: CasLeaseNodeRequest; response: CasLeaseNodeResponse };
  leaseExisting: { request: CasLeaseExistingRequest; response: CasLeaseExistingResponse };
  usage: { request: CasUsageRequest; response: CasUsageResponse };
  gc: { request: CasGcRequest; response: CasGcResponse };
  rootRefs: { request: CasRootRefsRequest; response: CasRootRefsResponse };
  rootAssignments: {
    request: CasRootAssignmentsRequest;
    response: CasRootAssignmentsResponse;
  };
  readPortableNode: {
    request: CasReadPortableNodeRequest;
    response: CasReadPortableNodeResponse;
  };
  leasePortableNode: {
    request: CasLeasePortableNodeRequest;
    response: CasLeasePortableNodeResponse;
  };
}
