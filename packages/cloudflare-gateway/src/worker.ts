/**
 * UniDocs API Gateway
 *
 * Cloudflare entry point: wires the cloud-neutral routing logic in
 * `@unidocs/gateway-common`'s `createGatewayHandler` to Cloudflare-specific
 * bindings (deployment-time Doc registry, Gateway-owned D1 directory,
 * CAS service binding).
 *
 * Identity:
 *   Public userId comes from the URL path.
 *   Future Bearer tokens must bind to that userId.
 *
 * Internal auth:
 *   Gateway → doc worker / CAS worker: X-Internal-Token
 *   Gateway → CAS worker: X-Tenant-Id resolved by Gateway
 */

import {
  createGatewayHandler,
  createInsecurePathIdentityResolver,
  StaticDocServiceRegistry,
} from "@unidocs/gateway-common";
import { isLegacyPublicCasRoute } from "@unidocs/protocol-gateway";
import { D1GatewayDocumentDirectory } from "./document-directory.js";

interface Env {
  GATEWAY_DB: D1Database;
  DOC_SERVICES_JSON: string;
  CAS_ACCESS_KEY: string;
  INSECURE_PATH_IDENTITY?: string;
  CAS_SERVICE: Fetcher;
}

let cachedRegistrySource: string | undefined;
let cachedRegistry: StaticDocServiceRegistry | undefined;

function registry(env: Env): StaticDocServiceRegistry {
  if (!cachedRegistry || cachedRegistrySource !== env.DOC_SERVICES_JSON) {
    cachedRegistry = new StaticDocServiceRegistry(env.DOC_SERVICES_JSON);
    cachedRegistrySource = env.DOC_SERVICES_JSON;
  }
  return cachedRegistry;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handle = createGatewayHandler({
      casAccessKey: env.CAS_ACCESS_KEY,
      identityResolver: createInsecurePathIdentityResolver(
        env.INSECURE_PATH_IDENTITY === "true",
      ),
      resolveDocService: (docType) => registry(env).resolve(docType),
      casFetcher: env.CAS_SERVICE,
      directory: new D1GatewayDocumentDirectory(env.GATEWAY_DB),
      isPublicCasRoute: isLegacyPublicCasRoute,
    });
    return handle(request);
  },
};
