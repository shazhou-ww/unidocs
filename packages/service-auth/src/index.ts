/**
 * @unidocs/service-auth — Cloud-neutral internal capability issuance and
 * verification for UniDocs.
 *
 * The CAS-neutral capability contract (permissions, claims, errors) is owned
 * by `@unicas/tenant-protocol` and re-exported here unchanged, so the
 * application-stack gateway and the independently deployable CAS middleware
 * share one vocabulary. This package keeps the issuance/verification
 * machinery (`CapabilityIssuer`, `CapabilityVerifier`, runtime helpers).
 */

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
} from "@unicas/tenant-protocol";
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
} from "@unicas/tenant-protocol";
export {
  CapabilityIssuer,
  JoseCapabilitySigner,
} from "./issuer.js";
export type {
  CapabilityIssuerConfig,
  CapabilitySigner,
  IssueCapabilityInput,
} from "./issuer.js";
export {
  CapabilityVerifier,
  extractBearerCapability,
  requireCapabilityPermission,
  requireCapabilitySession,
  requireCapabilityTenant,
} from "./verifier.js";
export type { CapabilityVerifierConfig } from "./verifier.js";
export {
  createPkcs8CapabilityIssuer,
  derivePkcs8CapabilityPublicJwk,
  parseCapabilityRuntimePolicy,
} from "./runtime.js";
export type {
  CapabilityRuntimePolicy,
  CapabilityRuntimePolicyBindings,
  Pkcs8CapabilityIssuerConfig,
} from "./runtime.js";
export {
  deriveOAuthIssuerMetadataUrl,
  discoverOAuthIssuerJwksUri,
  isHttpsIssuerUrl,
} from "./discovery.js";
export type { DiscoveredOAuthIssuerMetadata } from "./discovery.js";
export {
  CasAuthorizationHeader, PlatformDelegationHeader, PlatformHmacHeaders,
  PlatformHmacError, importPlatformHmacKey, signPlatformRequest, verifyPlatformRequest,
} from "./platform-hmac.js";
export type {
  PlatformHmacKey, PlatformHmacTarget, PlatformNonceStore,
  VerifiedPlatformRequest, VerifyPlatformRequestOptions,
} from "./platform-hmac.js";
export { OperatorProbeError, createOperatorProbeRequest, signOperatorProbeReceipt, verifyOperatorProbeReceipt, verifyOperatorProbeRequest } from "./operator-probe.js";
export type { OperatorProbeReceipt, OperatorProbeRequestBody } from "./operator-probe.js";
export {
  OperatorWebhookSignatureHeader, OperatorWebhookTimestampHeader,
  signOperatorWebhook, verifyOperatorWebhook,
} from "./operator-webhook.js";