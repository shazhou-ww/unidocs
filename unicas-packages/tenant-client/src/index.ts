/** Functional, tenant-bound CAS client. */

export type {
  CasGcOptions,
  CasGcResult,
  CasHash,
  CasHttpFetcher,
  CasLeaseOptions,
  CasLeaseResult,
  CasNodeCache,
  CasNodeCacheKey,
  CasNodeRange,
  CasNodeReader,
  CasNodeSource,
  CasNodeMetadata,
  CasRootRefUpdate,
  CasRootRefsResult,
  CasUsage,
  HttpFetcher,
  TenantCasClient,
  TenantCasClientConfig,
} from "./types.js";

export { createTenantCasClient } from "./client.js";
export { CasClientError } from "./errors.js";
