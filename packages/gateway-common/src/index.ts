/**
 * @unidocs/gateway-common — Cloud-neutral UniDocs API Gateway routing.
 * The one piece of shared implementation code the gateway microservices
 * (Cloudflare worker, Azure/Node service) have in common.
 */

export { createGatewayHandler } from "./gateway-handler.js";
export type {
	DocServiceRegistration,
	GatewayHandlerConfig,
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
export {
	createDataPlaneIdentityResolver,
	createOAuthAccessTokenIdentityResolver,
} from "./access-token-identity.js";
export type {
	DataPlaneIdentityOptions,
	OAuthAccessTokenIdentityConfig,
} from "./access-token-identity.js";
export { StaticDocServiceRegistry } from "./doc-service-registry.js";
export { AdminTypeDirectory } from "./admin-type-directory.js";
export type { ApprovedDocTypeEndpoint } from "./admin-type-directory.js";
export { adminTypeEtag, normalizeDocTypeBaseUrl, parseDocTypeDescriptor } from "./admin-type-contract.js";
export type { AdminTypeRegistration, AdminUrlValidation, DocTypeDescriptor } from "./admin-type-contract.js";
export { AdminDirectory, AdminDirectoryError, normalizeAdminEmail } from "./admin-directory.js";
export type { AdminActor, Administrator, AdminAuditEvent, AdminCommandResult, AdminGoogleIdentity, AdminDirectoryStore, AdminDirectoryTransaction } from "./admin-directory.js";
export { createAdminHandler, administratorEtag } from "./admin-handler.js";
export type { AdminBrowserSession, AdminHandlerOptions } from "./admin-handler.js";
export { casCapabilityPolicy, docCapabilityPolicy } from "./capability-policy.js";
export type { CasCapabilityPolicy, DocCapabilityPolicy } from "./capability-policy.js";
export { GatewayCapabilityAuthority } from "./capability-authority.js";
export type {
	DocOperationCredentials,
	GatewayCapabilityAuditEvent,
	GatewayCapabilityAuthorityConfig,
	GatewayCapabilityIssuer,
} from "./capability-authority.js";

// 适配器只依赖 gateway-common,所以观测相关的类型与默认 sink 从这里转出,
// 免得每个网关适配器都要单独声明一次 @unidocs/protocol-doc 依赖。
export { consoleObserver, noopObserver } from "@unidocs/protocol-doc";
export type { HttpCallEvent, ObserveFn } from "@unidocs/protocol-doc";
