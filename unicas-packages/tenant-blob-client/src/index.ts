/**
 * @unicas/tenant-blob-client — Blob layer above `@unicas/tenant-client`.
 *
 * The complete tenant data-plane interface for business users: write blobs
 * (chunked into CAS nodes behind a blob-index tree), random-access reads
 * (SBlobHandler-shaped handles), and tenant admin (stat/usage/gc). The
 * underlying node-level HTTP client in `@unicas/tenant-client` is only used
 * to construct this layer.
 */

export {
  createCasBlobClient,
} from "./blob-client.js";

export {
  leaseNodeContent,
  storeNodeContent,
} from "./node-content.js";

export type {
  CasBlobClient,
  CasBlobClientOptions,
  CasBlobHandle,
  CasBlobRef,
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
