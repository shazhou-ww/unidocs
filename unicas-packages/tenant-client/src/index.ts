/** Functional, tenant-bound CAS client. */

export type {
  CasGcOptions,
  CasGcResult,
  CasHash,
  CasHttpFetcher,
  CasLeaseOptions,
  CasLeaseResult,
  CasListRootRefsOptions,
  CasNodeCache,
  CasNodeCacheKey,
  CasNodeRange,
  CasNodeSource,
  CasNodeMetadata,
  CasRootRefUpdate,
  CasRootRefsPage,
  CasRootRefsResult,
  CasUsage,
  HttpFetcher,
  TenantCasClient,
  TenantCasClientConfig,
} from "./types.js";

export { createTenantCasClient } from "./client.js";
export { CasClientError } from "./errors.js";
