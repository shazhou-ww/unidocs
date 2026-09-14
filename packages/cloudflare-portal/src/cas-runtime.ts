/**
 * Assembles the Platform's snapshot store from worker bindings.
 *
 * The chain is: stack signing key -> capability issuer -> a read capability
 * carrying the stack's refDomain -> tenant CAS client -> blob client -> store.
 * The store is assembled per tenant because a capability is tenant-scoped, but
 * the issuer itself is not: `createPortalCasIssuer` builds it once from the
 * raw PKCS8 key, and `createPortalCasRuntime` accepts a pre-built issuer so a
 * caller serving many tenants per request (Plan 2's repository, Plan 3's
 * submissions endpoint) can hoist it instead of re-importing the key on every
 * call. Omitting it falls back to building a fresh one, which keeps a
 * single-tenant call site simple at the cost of that re-import.
 *
 * Hoisting the issuer only avoids re-importing the key - it does not avoid
 * minting tokens. `createTenantCasClient` calls `getToken()` on every HTTP
 * request it makes to CAS, and the `getToken` this module hands it
 * (`createPlatformCasCapability`, cas-capability.ts) signs a fresh ES256 JWT
 * on every call, with no caching: one snapshot read plus one retain produced
 * five distinct tokens in the integration run. That per-request signing cost
 * is a known, deliberate gap, not something this seam already solved. The
 * knob a future caching layer would use is `PlatformCasCapabilityConfig.lifetimeSeconds`
 * (cas-capability.ts) - accepted by `createPlatformCasCapability` but not
 * currently passed by anything here, and untested. Do not add caching in this
 * module; it belongs to a later slice with its own benchmark.
 */
import { createCasBlobClient } from "@unicas/tenant-blob-client";
import { createTenantCasClient } from "@unicas/tenant-client";
import { createPkcs8CapabilityIssuer, type CapabilityIssuer } from "@unidocs/service-auth";
import { createPlatformCasCapability } from "./cas-capability.js";
import { createSnapshotStore, type SnapshotStore } from "./snapshot-store.js";

export interface PortalCasEnv {
  readonly CAS_ORIGIN: string;
  readonly CAS_STACK_ID: string;
  readonly CAS_ISSUER: string;
  readonly CAS_AUDIENCE: string;
  readonly CAS_REF_DOMAIN: string;
  readonly CAS_SIGNING_KID: string;
  readonly CAS_SIGNING_KEY: string;
}

const PLATFORM_SUBJECT = "platform:portal";

const REQUIRED_BINDINGS = [
  "CAS_ORIGIN", "CAS_STACK_ID", "CAS_ISSUER",
  "CAS_AUDIENCE", "CAS_REF_DOMAIN", "CAS_SIGNING_KID", "CAS_SIGNING_KEY",
] as const;

function assertBindingsPresent(env: PortalCasEnv): void {
  for (const name of REQUIRED_BINDINGS) {
    if (!env[name]) throw new TypeError(`Portal CAS binding ${name} is missing`);
  }
}

/**
 * Builds the Platform's capability issuer from its stack signing key. This is
 * the reusable half of the chain: unlike the capability it signs, the issuer
 * is not tenant-scoped, so a caller serving many tenants should build it once
 * (e.g. per worker invocation, or hoisted further where the runtime allows)
 * and pass it into `createPortalCasRuntime` instead of letting each call
 * re-import the raw key.
 */
export async function createPortalCasIssuer(env: PortalCasEnv): Promise<CapabilityIssuer> {
  assertBindingsPresent(env);
  return createPkcs8CapabilityIssuer({
    issuer: env.CAS_ISSUER,
    kid: env.CAS_SIGNING_KID,
    privateKeyPkcs8: env.CAS_SIGNING_KEY,
  });
}

export async function createPortalCasRuntime(
  env: PortalCasEnv,
  tenantId: string,
  issuer?: CapabilityIssuer,
): Promise<SnapshotStore> {
  assertBindingsPresent(env);

  const resolvedIssuer = issuer ?? await createPortalCasIssuer(env);

  const cas = createTenantCasClient({
    baseUrl: env.CAS_ORIGIN,
    stackId: env.CAS_STACK_ID,
    tenantId,
    getToken: createPlatformCasCapability({
      issuer: resolvedIssuer,
      tenantId,
      audience: env.CAS_AUDIENCE,
      subject: PLATFORM_SUBJECT,
      refDomain: env.CAS_REF_DOMAIN,
    }),
  });

  return createSnapshotStore(createCasBlobClient(cas));
}
