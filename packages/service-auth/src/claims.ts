import type { JWTHeaderParameters, JWTPayload } from "jose";
import type { CapabilityPermission } from "./permissions.js";

export const CapabilityVersion = 1 as const;
export const CapabilityAlgorithm = "ES256" as const;
export const CapabilityTokenType = "unidocs-cap+jwt" as const;
export const DefaultCapabilityLifetimeSeconds = 120;
export const MaximumCapabilityLifetimeSeconds = 300;
export const MaximumCapabilityClockSkewSeconds = 30;

export interface CapabilityProtectedHeader extends JWTHeaderParameters {
  readonly alg: typeof CapabilityAlgorithm;
  readonly kid: string;
  readonly typ: typeof CapabilityTokenType;
}

export interface CapabilityClaimsBase extends JWTPayload {
  readonly ver: typeof CapabilityVersion;
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
  readonly tenantId: string;
  readonly permissions: readonly CapabilityPermission[];
  /** Stable business domain for Root Refs writes; only present on
   *  stack-authority capabilities that write root references. Registration is
   *  the stack's authority registry; the verifier never trusts caller input. */
  readonly refDomain?: string;
}

export interface TenantCapabilityClaims extends CapabilityClaimsBase {
  readonly sessionId?: never;
}

export interface SessionCapabilityClaims extends CapabilityClaimsBase {
  readonly sessionId: string;
}

export type CapabilityClaims = TenantCapabilityClaims | SessionCapabilityClaims;

export interface VerifiedCapability {
  readonly protectedHeader: CapabilityProtectedHeader;
  readonly claims: CapabilityClaims;
}

/**
 * Root Refs domain format: lowercase alnum segments joined by `:`, bounded.
 * The `_`-prefix namespace is reserved for platform/migration baselines and
 * can never be signed as a caller-selectable domain.
 */
export const REF_DOMAIN_MAX_LENGTH = 64;
export const REF_DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?::[a-z0-9]+)*$/;

export function isReservedRefDomain(domain: string): boolean {
  return domain === "_legacy" || domain.startsWith("_");
}

/** Returns null when the value is a valid refDomain, otherwise a message. */
export function validateRefDomainClaim(value: unknown): string | null {
  if (typeof value !== "string") return "refDomain must be a string";
  if (value.length === 0) return "refDomain must not be empty";
  if (value.length > REF_DOMAIN_MAX_LENGTH) {
    return `refDomain must be at most ${REF_DOMAIN_MAX_LENGTH} characters`;
  }
  if (!REF_DOMAIN_PATTERN.test(value)) {
    return "refDomain must be lowercase segments of letters/digits joined by ':'";
  }
  if (isReservedRefDomain(value)) return `refDomain '${value}' is reserved`;
  return null;
}