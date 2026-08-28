/** Functional, tenant-bound CAS client. */

export type {
  CasBlobClient,
  CasBlobClientOptions,
  CasBlobRef,
  CasBlobSource,
  CasBlobWriteOptions,
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
export type { LegacyTenantCasClientConfig } from "./legacy-types.js";

export { createCasBlobClient, leaseNodeContent, storeNodeContent } from "./blob.js";
export { createTenantCasClient } from "./client.js";
export { createLegacyTenantCasClient } from "./legacy.js";
export { CasClientError } from "./errors.js";
