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