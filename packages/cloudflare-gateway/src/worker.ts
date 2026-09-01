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
 * Internal service calls use short-lived Doc and stack CAS capabilities.
 */

import {
  consoleObserver,
  createGatewayHandler,
  createInsecureTenantIdentityResolver,
  GatewayCapabilityAuthority,
  StaticDocServiceRegistry,
} from "@unidocs/gateway-common";
import {
  createGatewayOAuthAuthorizationServerHandler,
  createGatewayOAuthDiscoveryHandler,
  type GatewayOAuthAuthorizationServerHandler,
  type GatewayOAuthDiscoveryHandler,
} from "@unidocs/gateway-oauth";
import { isGatewayExposedCasRoute } from "@unidocs/protocol-gateway";
import {
  createPkcs8CapabilityIssuer,
  derivePkcs8CapabilityPublicJwk,
  parseCapabilityRuntimePolicy,
  type CapabilityRuntimePolicyBindings,
} from "@unidocs/service-auth";
import { D1GatewayDocumentDirectory } from "./document-directory.js";
import { renderCloudflareGatewayOAuthConsent } from "./oauth-consent.js";
import {
  cleanupGatewayOAuthD1,
  D1GatewayOAuthAuditPort,
  D1GatewayOAuthAuthorizationCodeStore,
  D1GatewayOAuthAuthorizationTransactionStore,
  D1GatewayOAuthClientStore,
  D1GatewayOAuthRefreshTokenStore,
  D1GatewayOAuthTenantMembershipStore,
} from "./oauth-d1.js";
import {
  createCloudflareGatewayOAuthIdentity,
  type CloudflareGatewayOAuthIdentityBindings,
} from "./oauth-identity.js";

interface Env extends CapabilityRuntimePolicyBindings, CloudflareGatewayOAuthIdentityBindings {
  GATEWAY_DB: D1Database;
  DOC_SERVICES_JSON: string;
  CAPABILITY_PRIVATE_KEY_PKCS8?: string;
  CAPABILITY_KEY_ID?: string;
  CAPABILITY_ISSUER?: string;
  CAS_CAPABILITY_AUDIENCE?: string;
  /** Stack mode: the registered unidocs-cloudflare stack CAS identity. */
  CAS_STACK_ID?: string;
  CAS_STACK_ISSUER?: string;
  CAS_STACK_KEY_ID?: string;
  CAS_STACK_PRIVATE_KEY_PKCS8?: string;
  /** Standards-based OAuth issuer. During migration it must equal CAS_STACK_ISSUER. */
  GATEWAY_OAUTH_ISSUER?: string;
  GATEWAY_OAUTH_REFRESH_TTL_SECONDS?: string;
  /** refDomain claim carried by CAS capabilities (stack mode). */
  CAS_REF_DOMAIN?: string;
  INSECURE_PATH_IDENTITY?: string;
  CAS_SERVICE: Fetcher;
}

let cachedRegistrySource: string | undefined;
let cachedRegistry: StaticDocServiceRegistry | undefined;
// Env-keyed: Miniflare may reuse a worker isolate (and its module state)
// across sequential runtimes in one process; a bare module-level cache would
// leak the PREVIOUS runtime's capability authority into the next one.
const capabilityAuthorityCache = new WeakMap<object, Promise<GatewayCapabilityAuthority>>();
const oauthDiscoveryCache = new WeakMap<object, Promise<GatewayOAuthDiscoveryHandler | null>>();
const oauthServerCache = new WeakMap<object, Promise<GatewayOAuthAuthorizationServerHandler | null>>();

function registry(env: Env): StaticDocServiceRegistry {
  if (!cachedRegistry || cachedRegistrySource !== env.DOC_SERVICES_JSON) {
    cachedRegistry = new StaticDocServiceRegistry(env.DOC_SERVICES_JSON);
    cachedRegistrySource = env.DOC_SERVICES_JSON;
  }
  return cachedRegistry;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const oauthDiscovery = await oauthDiscoveryHandler(env);
    const discoveryResponse = oauthDiscovery && await oauthDiscovery(request);
    if (discoveryResponse) return discoveryResponse;
    const oauthServer = await oauthAuthorizationServer(env);
    const oauthResponse = oauthServer && await oauthServer(request);
    if (oauthResponse) return oauthResponse;
    const casStackId = requireBinding(env.CAS_STACK_ID, "CAS_STACK_ID");
    const handle = createGatewayHandler({
      capabilityAuthority: await capabilityAuthority(env),
      identityResolver: createInsecureTenantIdentityResolver(
        env.INSECURE_PATH_IDENTITY === "true",
      ),
      resolveDocService: (docType) => registry(env).resolve(docType),
      casFetcher: env.CAS_SERVICE,
      directory: new D1GatewayDocumentDirectory(env.GATEWAY_DB),
      isGatewayExposedCasRoute,
      casStackId,
      observe: consoleObserver,
    });
    return handle(request);
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(cleanupGatewayOAuthD1(env.GATEWAY_DB).then(result => {
      console.log(JSON.stringify({ event: "gateway_oauth_cleanup", ...result }));
    }));
  },
};

function oauthDiscoveryHandler(env: Env): Promise<GatewayOAuthDiscoveryHandler | null> {
  let cached = oauthDiscoveryCache.get(env);
  if (!cached) {
    cached = createOAuthDiscoveryHandler(env);
    oauthDiscoveryCache.set(env, cached);
  }
  return cached;
}

async function createOAuthDiscoveryHandler(env: Env): Promise<GatewayOAuthDiscoveryHandler | null> {
  if (!env.GATEWAY_OAUTH_ISSUER) return null;
  const casIssuer = requireBinding(env.CAS_STACK_ISSUER, "CAS_STACK_ISSUER");
  if (env.GATEWAY_OAUTH_ISSUER !== casIssuer) {
    throw new Error("GATEWAY_OAUTH_ISSUER must exactly equal CAS_STACK_ISSUER");
  }
  const kid = requireBinding(env.CAS_STACK_KEY_ID, "CAS_STACK_KEY_ID");
  const publicJwk = await derivePkcs8CapabilityPublicJwk(requireBinding(
    env.CAS_STACK_PRIVATE_KEY_PKCS8,
    "CAS_STACK_PRIVATE_KEY_PKCS8",
  ));
  const issuerBase = env.GATEWAY_OAUTH_ISSUER.replace(/\/$/, "");
  return createGatewayOAuthDiscoveryHandler({
    metadata: {
      issuer: env.GATEWAY_OAUTH_ISSUER,
      registrationEndpoint: `${issuerBase}/register`,
      revocationEndpoint: `${issuerBase}/revoke`,
    },
    signingKeys: {
      publicSigningKeys: async () => [{ algorithm: "ES256", kid, publicJwk }],
    },
  });
}

function oauthAuthorizationServer(
  env: Env,
): Promise<GatewayOAuthAuthorizationServerHandler | null> {
  let cached = oauthServerCache.get(env);
  if (!cached) {
    cached = createOAuthAuthorizationServer(env);
    oauthServerCache.set(env, cached);
  }
  return cached;
}

async function createOAuthAuthorizationServer(
  env: Env,
): Promise<GatewayOAuthAuthorizationServerHandler | null> {
  if (!env.GATEWAY_OAUTH_ISSUER) return null;
  const casIssuer = requireBinding(env.CAS_STACK_ISSUER, "CAS_STACK_ISSUER");
  if (env.GATEWAY_OAUTH_ISSUER !== casIssuer) {
    throw new Error("GATEWAY_OAUTH_ISSUER must exactly equal CAS_STACK_ISSUER");
  }
  const policy = parseCapabilityRuntimePolicy(env);
  const capabilityIssuer = await createPkcs8CapabilityIssuer({
    issuer: casIssuer,
    kid: requireBinding(env.CAS_STACK_KEY_ID, "CAS_STACK_KEY_ID"),
    privateKeyPkcs8: requireBinding(
      env.CAS_STACK_PRIVATE_KEY_PKCS8,
      "CAS_STACK_PRIVATE_KEY_PKCS8",
    ),
    defaultLifetimeSeconds: policy.defaultLifetimeSeconds,
    maximumLifetimeSeconds: policy.maximumLifetimeSeconds,
  });
  const now = (): number => Math.floor(Date.now() / 1000);
  const clients = new D1GatewayOAuthClientStore(env.GATEWAY_DB);
  const transactions = new D1GatewayOAuthAuthorizationTransactionStore(env.GATEWAY_DB, now);
  const codes = new D1GatewayOAuthAuthorizationCodeStore(env.GATEWAY_DB, now);
  const refreshTokens = new D1GatewayOAuthRefreshTokenStore(env.GATEWAY_DB);
  const memberships = new D1GatewayOAuthTenantMembershipStore(env.GATEWAY_DB);
  const audit = new D1GatewayOAuthAuditPort(env.GATEWAY_DB, now);
  return createGatewayOAuthAuthorizationServerHandler({
    issuer: env.GATEWAY_OAUTH_ISSUER,
    identity: createCloudflareGatewayOAuthIdentity(env),
    registration: { clients, clock: { now }, audit },
    authorization: {
      clients,
      transactions,
      codes,
      memberships,
      clock: { now },
      audit,
    },
    token: {
      codes,
      refreshTokens,
      capabilityIssuer,
      audience: requireBinding(env.CAS_CAPABILITY_AUDIENCE, "CAS_CAPABILITY_AUDIENCE"),
      clock: { now },
      audit,
      accessTokenLifetimeSeconds: policy.defaultLifetimeSeconds,
      ...(env.GATEWAY_OAUTH_REFRESH_TTL_SECONDS === undefined
        ? {}
        : { refreshTokenLifetimeSeconds: refreshTokenLifetime(env.GATEWAY_OAUTH_REFRESH_TTL_SECONDS) }),
    },
    renderConsent: renderCloudflareGatewayOAuthConsent,
  });
}

function capabilityAuthority(
  env: Env,
): Promise<GatewayCapabilityAuthority> {
  let cached = capabilityAuthorityCache.get(env);
  if (!cached) {
    cached = createCapabilityAuthority(env);
    capabilityAuthorityCache.set(env, cached);
  }
  return cached;
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
  const stackId = requireBinding(env.CAS_STACK_ID, "CAS_STACK_ID");
  const casIssuer = await createPkcs8CapabilityIssuer({
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

function refreshTokenLifetime(value: string): number {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 300 || seconds > 90 * 24 * 60 * 60) {
    throw new Error("GATEWAY_OAUTH_REFRESH_TTL_SECONDS must be an integer from 300 to 7776000");
  }
  return seconds;
}
