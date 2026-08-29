/**
 * @unicas/codec — Wire-format encodings for the CAS tenant data plane.
 *
 * Pure encoding, no I/O, no platform binding, no HTTP contracts. Split out of
 * `@unicas/tenant-protocol` (2026-08-29) so the encoding layer can be
 * published and tested independently; `@unicas/tenant-protocol` now focuses on
 * HTTP request/response types and does NOT re-export these symbols.
 *
 * Consumers that only need node/blob encoding depend on this package alone.
 */

// Canonical node binary format
export {
  HEADER_SIZE,
  SIGNATURE,
  VERSION,
  MAX_CONTENT_TYPE_LENGTH,
  MIN_CONTENT_TYPE_LENGTH,
  HASH_SIZE,
  HASH_HEX_LENGTH,
  encodeHeader,
  decodeHeader,
  concatenateNodeBytes,
  parseNodeBytes,
} from "./binary.js";

// Node digest
export {
  sha256,
  computeNodeDigest,
  hashToHex,
  hexToHash,
} from "./digest.js";

// Streaming canonical node codec
export {
  CanonicalNodeContentType,
  parseCanonicalNodeStream,
} from "./canonical-stream.js";
export type { ParsedCanonicalNodeStream } from "./canonical-stream.js";

// Wire constraints and validation
export {
  MAX_CANONICAL_NODE_BYTES,
  MAX_NODE_REFS,
  validateCanonicalNodeSize,
  validateHash,
  validateRawHash,
  validateContentType,
  validateDecodedHeader,
  validateChildRefs,
  validateContentLength,
} from "./validation.js";
export type { CanonicalNodeLimits } from "./validation.js";

// Blob index CBOR codec
export {
  BlobChunkBytes,
  BlobChunkContentType,
  BlobIndexContentType,
  BlobIndexFanout,
  decodeBlobIndex,
  encodeBlobIndex,
  validateBlobIndex,
} from "./blob.js";
export type { CasBlobIndexV1 } from "./blob.js";
