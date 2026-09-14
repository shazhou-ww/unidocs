/**
 * Assembles the Platform's snapshot store from worker bindings.
 *
 * The chain is: stack signing key -> capability issuer -> a read capability
 * carrying the stack's refDomain -> tenant CAS client -> blob client -> store.
 * It is assembled per tenant because a capability is tenant-scoped; the
 * issuer itself is not, so callers that serve many tenants should hoist the
 * issuer rather than re-import the key per request.
 */
import { createCasBlobClient } from "@unicas/tenant-blob-client";
import { createTenantCasClient } from "@unicas/tenant-client";
import { createPkcs8CapabilityIssuer } from "@unidocs/service-auth";
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

export async function createPortalCasRuntime(
  env: PortalCasEnv,
  tenantId: string,
): Promise<SnapshotStore> {
  for (const name of [
    "CAS_ORIGIN", "CAS_STACK_ID", "CAS_ISSUER",
    "CAS_AUDIENCE", "CAS_REF_DOMAIN", "CAS_SIGNING_KID", "CAS_SIGNING_KEY",
  ] as const) {
    if (!env[name]) throw new TypeError(`Portal CAS binding ${name} is missing`);
  }

  const issuer = await createPkcs8CapabilityIssuer({
    issuer: env.CAS_ISSUER,
    kid: env.CAS_SIGNING_KID,
    privateKeyPkcs8: env.CAS_SIGNING_KEY,
  });

  const cas = createTenantCasClient({
    baseUrl: env.CAS_ORIGIN,
    stackId: env.CAS_STACK_ID,
    tenantId,
    getToken: createPlatformCasCapability({
      issuer,
      tenantId,
      audience: env.CAS_AUDIENCE,
      subject: PLATFORM_SUBJECT,
      refDomain: env.CAS_REF_DOMAIN,
    }),
  });

  return createSnapshotStore(createCasBlobClient(cas));
}
