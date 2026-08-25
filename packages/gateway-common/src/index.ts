/**
 * @unidocs/gateway-common — Cloud-neutral UniDocs API Gateway routing.
 * The one piece of shared implementation code the gateway microservices
 * (Cloudflare worker, Azure/Node service) have in common.
 */

export { createGatewayHandler } from "./gateway-handler.js";
export type { DocServiceRegistration, GatewayHandlerConfig } from "./gateway-handler.js";
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
export { createInsecurePathIdentityResolver } from "./identity.js";
export type { GatewayIdentity, GatewayIdentityResolver } from "./identity.js";
export { StaticDocServiceRegistry } from "./doc-service-registry.js";
