/**
 * @unicas/tenant-protocol — CAS tenant data-plane HTTP contracts.
 *
 * HTTP request/response types, route definitions, and the CAS capability
 * claim vocabulary. Wire encodings (node binary format, digest, blob index)
 * live in @unicas/codec and are intentionally NOT re-exported here.
 */

export {
  CasApiErrorMap,
  CasTenantApiBasePath,
  casTenantApiContract,
} from "./contract.js";
export type { CasTenantApiContract } from "./contract.js";

export type {
  CasGcResult,
  CasHash,
  CasLeaseOperationResult,
  CasLeaseResult,
  CasNode,
  CasNodeDescriptor,
  CasNodeMetadata,
  CasNodeState,
  CasRefChanges,
  CasReferences,
  CasRootRefBalance,
  CasRootRefsPage,
  CasRootRefUpdate,
  CasUploadRequiredResult,
  CasUsage,
} from "./types.js";

export {
  CasGcResultSchema,
  CasHashSchema,
  CasLeaseOperationResultSchema,
  CasLeaseResultSchema,
  CasNodeDescriptorSchema,
  CasNodeMetadataSchema,
  CasNodeSchema,
  CasNodeStateSchema,
  CasRefChangesSchema,
  CasReferencesSchema,
  CasRootRefBalanceSchema,
  CasRootRefsPageSchema,
  CasRootRefUpdateSchema,
  CasUploadRequiredResultSchema,
  CasUsageSchema,
} from "./schemas.js";

export {
  CasLeaseDurationHeader,
  CasUploadIdHeader,
  CasUploadLengthHeader,
} from "./http.js";
export type {
  CasEndpointContracts,
  CasErrorResponse,
  CasGcRequest,
  CasGcResponse,
  CasLeaseRequest,
  CasLeaseResponse,
  CasListRootRefsRequest,
  CasListRootRefsResponse,
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

// CAS-neutral tenant capability claim vocabulary
export {
  canonicalPermissionSegment,
  casManagePermission,
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
