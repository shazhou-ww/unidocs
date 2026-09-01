/**
 * @unidocs/gateway-oauth — cloud-neutral OAuth authorization server core for
 * UniDocs Gateways.
 */

export {
  canonicalizeGatewayOAuthIssuer,
  gatewayOAuthMetadataPath,
  gatewayOpenIdConfigurationPath,
  renderGatewayOAuthMetadata,
} from "./metadata.js";
export type {
  GatewayOAuthAuthorizationServerMetadata,
  GatewayOAuthServerMetadataConfig,
} from "./metadata.js";
export { renderGatewayOAuthJwks } from "./jwks.js";
export type {
  GatewayOAuthJwks,
  GatewayOAuthPublicSigningKey,
  GatewayOAuthSigningKeySetPort,
} from "./jwks.js";
export {
  GatewayOAuthScopes,
  gatewayOAuthScopesToCapabilityPermissions,
  isGatewayOAuthScope,
} from "./scopes.js";
export type { GatewayOAuthScope } from "./scopes.js";
export { GatewayOAuthProtocolError } from "./errors.js";
export type { GatewayOAuthErrorCode } from "./errors.js";
export { createGatewayOAuthDiscoveryHandler } from "./discovery-handler.js";
export type {
  GatewayOAuthDiscoveryHandler,
  GatewayOAuthDiscoveryHandlerConfig,
} from "./discovery-handler.js";
export {
  gatewayOAuthRedirectUriMatches,
  registerGatewayOAuthClient,
  validateGatewayOAuthRedirectUri,
} from "./client-registration.js";
export type {
  GatewayOAuthClientRegistrationPorts,
  GatewayOAuthClientRegistrationRequest,
  GatewayOAuthClientRegistrationResponse,
} from "./client-registration.js";
export {
  completeGatewayOAuthAuthorization,
  startGatewayOAuthAuthorization,
} from "./authorization.js";
export type {
  GatewayOAuthAuthorizationPorts,
  GatewayOAuthAuthorizationRequest,
  GatewayOAuthAuthorizationResult,
  GatewayOAuthPendingAuthorization,
} from "./authorization.js";
export {
  exchangeGatewayOAuthAuthorizationCode,
  refreshGatewayOAuthAccessToken,
  revokeGatewayOAuthRefreshToken,
} from "./token.js";
export type {
  GatewayOAuthAuthorizationCodeTokenRequest,
  GatewayOAuthRefreshTokenRequest,
  GatewayOAuthTokenPorts,
  GatewayOAuthTokenResponse,
} from "./token.js";
export {
  validateGatewayOAuthPkceS256Challenge,
  validateGatewayOAuthPkceVerifier,
  verifyGatewayOAuthPkceS256,
} from "./pkce.js";
export {
  systemGatewayOAuthHash,
  systemGatewayOAuthRandom,
} from "./crypto.js";
export type {
  GatewayOAuthAuditEvent,
  GatewayOAuthAuditPort,
  GatewayOAuthAuthenticatedUser,
  GatewayOAuthAuthorizationCodeStorePort,
  GatewayOAuthAuthorizationTransaction,
  GatewayOAuthAuthorizationTransactionStorePort,
  GatewayOAuthCapabilityIssuerPort,
  GatewayOAuthClientStorePort,
  GatewayOAuthClockPort,
  GatewayOAuthHashPort,
  GatewayOAuthIdentityPort,
  GatewayOAuthRandomPort,
  GatewayOAuthRefreshRotationResult,
  GatewayOAuthRefreshTokenStorePort,
  GatewayOAuthRegisteredClient,
  GatewayOAuthStoredAuthorizationCode,
  GatewayOAuthStoredRefreshToken,
  GatewayOAuthTenantMembership,
  GatewayOAuthTenantMembershipPort,
} from "./ports.js";
