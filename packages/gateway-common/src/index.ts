/**
 * @unidocs/gateway-common — Cloud-neutral UniDocs API Gateway routing.
 * The one piece of shared implementation code the gateway microservices
 * (Cloudflare worker, Azure/Node service) have in common.
 */

export { createGatewayHandler, parseGatewayInternalAuthMode } from "./gateway-handler.js";
export type {
	DocServiceRegistration,
	GatewayHandlerConfig,
	GatewayInternalAuthMode,
} from "./gateway-handler.js";
export {
	GatewayDirectoryConflictError,
	MemoryGatewayDocumentDirectory,
} from "./document-directory.js";
export type {
	GatewayDocumentDirectory,
	GatewayDocumentRecord,
	GatewayDocumentReservation,
	GatewayDocumentState,
	ReserveGatewayDocumentInput,
} from "./document-directory.js";
export { createInsecureTenantIdentityResolver } from "./identity.js";
export type { GatewayIdentity, GatewayIdentityResolver } from "./identity.js";
export { StaticDocServiceRegistry } from "./doc-service-registry.js";
export { casCapabilityPolicy, docCapabilityPolicy } from "./capability-policy.js";
export type { CasCapabilityPolicy, DocCapabilityPolicy } from "./capability-policy.js";
export { GatewayCapabilityAuthority } from "./capability-authority.js";
export type {
	DocOperationCredentials,
	GatewayCapabilityAuditEvent,
	GatewayCapabilityAuthorityConfig,
	GatewayCapabilityIssuer,
} from "./capability-authority.js";
