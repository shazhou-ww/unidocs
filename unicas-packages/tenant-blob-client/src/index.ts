/**
 * @unicas/tenant-blob-client — Blob layer above `@unicas/tenant-client`.
 *
 * The tenant blob interface for business users: write blobs, open
 * random-access handles, and retain/release blob roots. Node-level and tenant
 * administration operations remain available through `unicasClient`.
 */

export {
  createCasBlobClient,
} from "./blob-client.js";

export {
  leaseNodeContent,
  storeNodeContent,
} from "./node-content.js";

export { CasClientError } from "@unicas/tenant-client";

export type {
  CasBlobClient,
  CasBlobClientOptions,
  CasBlobHandle,
  CasBlobRef,
  CasBlobRetentionUpdate,
  CasBlobSource,
  CasBlobWriteOptions,
} from "./types.js";

// Blob index wire representation (client-side manifest; the CAS server
// never parses it).
export {
  BlobChunkBytes,
  BlobChunkContentType,
  BlobIndexContentType,
  BlobIndexFanout,
  decodeBlobIndex,
  encodeBlobIndex,
  validateBlobIndex,
} from "./blob-index.js";
export type { CasBlobIndexV1 } from "./blob-index.js";
