/**
 * @unicas/server-common — Content-addressed storage kernel for UniDocs.
 *
 * Pure logic, no I/O. Binary format, digest, validation. The CAS wire
 * contract types live in @unicas/protocol.
 */

// Binary format
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

// Digest
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

// Validation
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
