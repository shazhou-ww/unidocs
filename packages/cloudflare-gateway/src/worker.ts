/**
 * UniDocs API Gateway
 *
 * Cloudflare entry point: wires the cloud-neutral routing logic in
 * `@unidocs/gateway-common`'s `createGatewayHandler` to Cloudflare-specific
 * bindings (deployment-time Doc registry, Gateway-owned D1 directory,
 * CAS service binding).
 *
 * Identity:
 *   Public tenantId comes from the URL path and is authorized by Gateway.
 *
 * Internal auth:
 *   Gateway → doc worker / CAS worker: X-Internal-Token
 *   Gateway → CAS worker: X-Tenant-Id resolved by Gateway
 */

import {
  createGatewayHandler,
  createInsecureTenantIdentityResolver,
  GatewayCapabilityAuthority,
  parseGatewayInternalAuthMode,
  StaticDocServiceRegistry,
} from "@unidocs/gateway-common";
import type { GatewayInternalAuthMode } from "@unidocs/gateway-common";
import { isGatewayExposedCasRoute } from "@unidocs/protocol-gateway";
import {
  createPkcs8CapabilityIssuer,
  parseCapabilityRuntimePolicy,
  type CapabilityRuntimePolicyBindings,
} from "@unidocs/service-auth";
import { D1GatewayDocumentDirectory } from "./document-directory.js";

interface Env extends CapabilityRuntimePolicyBindings {
  GATEWAY_DB: D1Database;
  DOC_SERVICES_JSON: string;
  INTERNAL_AUTH_MODE?: string;
  CAS_ACCESS_KEY?: string;
  CAPABILITY_PRIVATE_KEY_PKCS8?: string;
  CAPABILITY_KEY_ID?: string;
  CAPABILITY_ISSUER?: string;
  CAS_CAPABILITY_AUDIENCE?: string;
  /** Stack mode: the registered unidocs-cloudflare stack CAS identity. */
  CAS_STACK_ID?: string;
  CAS_STACK_ISSUER?: string;
  CAS_STACK_KEY_ID?: string;
  CAS_STACK_PRIVATE_KEY_PKCS8?: string;
  /** refDomain claim carried by CAS capabilities (stack mode). */
  CAS_REF_DOMAIN?: string;
  INSECURE_PATH_IDENTITY?: string;
  CAS_SERVICE: Fetcher;
}

let cachedRegistrySource: string | undefined;
let cachedRegistry: StaticDocServiceRegistry | undefined;
let cachedCapabilityAuthority: Promise<GatewayCapabilityAuthority> | undefined;

function registry(env: Env): StaticDocServiceRegistry {
  if (!cachedRegistry || cachedRegistrySource !== env.DOC_SERVICES_JSON) {
    cachedRegistry = new StaticDocServiceRegistry(env.DOC_SERVICES_JSON);
    cachedRegistrySource = env.DOC_SERVICES_JSON;
  }
  return cachedRegistry;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const internalAuthMode = parseGatewayInternalAuthMode(env.INTERNAL_AUTH_MODE);
    const handle = createGatewayHandler({
      internalAuthMode,
      casAccessKey: env.CAS_ACCESS_KEY,
      capabilityAuthority: await capabilityAuthority(env, internalAuthMode),
      identityResolver: createInsecureTenantIdentityResolver(
        env.INSECURE_PATH_IDENTITY === "true",
      ),
      resolveDocService: (docType) => registry(env).resolve(docType),
      casFetcher: env.CAS_SERVICE,
      directory: new D1GatewayDocumentDirectory(env.GATEWAY_DB),
      isGatewayExposedCasRoute,
      casStackId: env.CAS_STACK_ID,
    });
    return handle(request);
  },
};

function capabilityAuthority(
  env: Env,
  mode: GatewayInternalAuthMode,
): Promise<GatewayCapabilityAuthority> | undefined {
  if (mode === "legacy") return undefined;
  cachedCapabilityAuthority ??= createCapabilityAuthority(env);
  return cachedCapabilityAuthority;
}

async function createCapabilityAuthority(env: Env): Promise<GatewayCapabilityAuthority> {
  const policy = parseCapabilityRuntimePolicy(env);
  const issuer = await createPkcs8CapabilityIssuer({
    issuer: requireBinding(env.CAPABILITY_ISSUER, "CAPABILITY_ISSUER"),
    kid: requireBinding(env.CAPABILITY_KEY_ID, "CAPABILITY_KEY_ID"),
    privateKeyPkcs8: requireBinding(
      env.CAPABILITY_PRIVATE_KEY_PKCS8,
      "CAPABILITY_PRIVATE_KEY_PKCS8",
    ),
    defaultLifetimeSeconds: policy.defaultLifetimeSeconds,
    maximumLifetimeSeconds: policy.maximumLifetimeSeconds,
  });
  const stackId = env.CAS_STACK_ID;
  const casIssuer = stackId === undefined
    ? undefined
    : await createPkcs8CapabilityIssuer({
      issuer: requireBinding(env.CAS_STACK_ISSUER, "CAS_STACK_ISSUER"),
      kid: requireBinding(env.CAS_STACK_KEY_ID, "CAS_STACK_KEY_ID"),
      privateKeyPkcs8: requireBinding(
        env.CAS_STACK_PRIVATE_KEY_PKCS8,
        "CAS_STACK_PRIVATE_KEY_PKCS8",
      ),
      defaultLifetimeSeconds: policy.defaultLifetimeSeconds,
      maximumLifetimeSeconds: policy.maximumLifetimeSeconds,
    });
  return new GatewayCapabilityAuthority({
    issuer,
    casIssuer,
    casAudience: requireBinding(env.CAS_CAPABILITY_AUDIENCE, "CAS_CAPABILITY_AUDIENCE"),
    casStackId: stackId,
    casRefDomain: env.CAS_REF_DOMAIN,
    audit: event => console.log(JSON.stringify({ event: "gateway_capability_issued", ...event })),
  });
}

function requireBinding(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Gateway capability configuration: ${name}`);
  return value;
}
