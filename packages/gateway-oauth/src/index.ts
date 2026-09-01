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
