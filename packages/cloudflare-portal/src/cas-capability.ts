/**
 * The Platform's own CAS credential.
 *
 * It is deliberately narrower than it looks: the Platform never writes blob
 * content - an Agent does that directly, because the tenant contract states
 * the Platform does not proxy CAS node traffic. What the Platform alone can do
 * is move business root references, which is why this capability carries a
 * refDomain and an Agent's does not.
 */
import { casReadPermission, type CapabilityIssuer } from "@unidocs/service-auth";

export interface PlatformCasCapabilityConfig {
  readonly issuer: CapabilityIssuer;
  readonly tenantId: string;
  readonly audience: string;
  readonly subject: string;
  /** Stable Root Refs domain; only stack-authority capabilities carry one. */
  readonly refDomain: string;
  readonly lifetimeSeconds?: number;
}

export function createPlatformCasCapability(
  config: PlatformCasCapabilityConfig,
): () => Promise<string> {
  if (!config.refDomain) {
    throw new TypeError("A Platform CAS capability must carry a Root Refs domain");
  }
  if (!config.tenantId || !config.audience || !config.subject) {
    throw new TypeError("A Platform CAS capability needs a tenant, audience and subject");
  }
  return async () => config.issuer.issue({
    subject: config.subject,
    audience: config.audience,
    tenantId: config.tenantId,
    permissions: [casReadPermission(config.tenantId)],
    refDomain: config.refDomain,
    ...(config.lifetimeSeconds === undefined ? {} : { lifetimeSeconds: config.lifetimeSeconds }),
  });
}
