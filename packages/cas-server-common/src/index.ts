/**
 * @unidocs/cas-server-common — Content-addressed storage kernel for UniDocs.
 *
 * Pure logic, no I/O. Types, binary format, digest, validation.
 */

// Types
export type {
  CasHash,
  CasNodeMetadata,
  CasNodeState,
  CasNodeDescriptor,
  CasLeaseResult,
  CasReferences,
  CasRefChanges,
  CasRootRefUpdate,
  CasRootAssignment,
  CasAssignRootsRequest,
  CasUsage,
  CasGcResult,
  UserCasService,
  CasNode,
} from "./types.js";

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

// Validation
export {
  validateHash,
  validateRawHash,
  validateContentType,
  validateDecodedHeader,
  validateChildRefs,
  validateContentLength,
} from "./validation.js";

// Gateway routing
export { isPublicCasRoute } from "./public-route.js";
