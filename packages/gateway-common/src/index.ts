/**
 * @unidocs/gateway-common — Cloud-neutral UniDocs API Gateway routing.
 * The one piece of shared implementation code the gateway microservices
 * (Cloudflare worker, Azure/Node service) have in common.
 */

export { createGatewayHandler } from "./gateway-handler.js";
export type { GatewayHandlerConfig } from "./gateway-handler.js";
