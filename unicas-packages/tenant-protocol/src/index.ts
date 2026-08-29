export type {
  CasGcResult,
  CasHash,
  CasLeaseResult,
  CasNode,
  CasNodeDescriptor,
  CasNodeMetadata,
  CasNodeState,
  CasRefChanges,
  CasReferences,
  CasRootRefUpdate,
  CasUsage,
} from "./types.js";

export {
  CasLeaseDurationHeader,
  CasRefsHeader,
} from "./http.js";
export type {
  CasEndpointContracts,
  CasErrorResponse,
  CasGcRequest,
  CasGcResponse,
  CasLeaseRequest,
  CasLeaseResponse,
  CasNodePath,
  CasReadContentRequest,
  CasReadContentResponse,
  CasReadMetadataRequest,
  CasReadMetadataResponse,
  CasStackPath,
  CasTenantPath,
  CasUpdateRootRefsRequest,
  CasUpdateRootRefsResponse,
  CasUsageRequest,
  CasUsageResponse,
} from "./http.js";

export { casRoutes, matchCasRoute } from "./routes.js";
export type { CasRoute } from "./routes.js";

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

// Canonical CAS node binary format (wire codec shared by server and client)
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

// Validation limits and checks
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

// CAS-neutral tenant capability claim vocabulary
export {
  canonicalPermissionSegment,
  casAdminPermission,
  casReadPermission,
  casWritePermission,
  hasCapabilityPermission,
  parseCapabilityPermission,
  sessionCreatePermission,
  sessionReadPermission,
  sessionWritePermission,
  CapabilityAlgorithm,
  CapabilityTokenType,
  CapabilityVersion,
  DefaultCapabilityLifetimeSeconds,
  isReservedRefDomain,
  MaximumCapabilityClockSkewSeconds,
  MaximumCapabilityLifetimeSeconds,
  REF_DOMAIN_MAX_LENGTH,
  REF_DOMAIN_PATTERN,
  validateRefDomainClaim,
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  CapabilityError,
} from "./capability.js";
export type {
  CapabilityClaims,
  CapabilityClaimsBase,
  CapabilityErrorCode,
  CapabilityPermission,
  CapabilityPermissionKind,
  CapabilityProtectedHeader,
  ParsedCapabilityPermission,
  SessionCapabilityClaims,
  TenantCapabilityClaims,
  VerifiedCapability,
} from "./capability.js";
