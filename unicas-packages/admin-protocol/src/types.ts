/**
 * Content-addressed node digest wire shape.
 * Defined locally so the admin protocol stays independent of the tenant plane.
 * 64 lowercase hexadecimal SHA-256 characters.
 */
export type CasHash = string;

/** Signed non-zero integer Root Ref deltas keyed by content hash. */
export type CasRefChanges = Readonly<Record<CasHash, number>>;

/** Opaque CAS-generated stack identifier. Never caller-chosen. */
export type CasStackId = string;

/** Immutable OIDC subject key: (identityIssuer, subject). Email is display-only. */
export interface CasOperatorIdentityKey {
  readonly identityIssuer: string;
  readonly subject: string;
}

export interface CasOperatorIdentity extends CasOperatorIdentityKey {
  readonly displayName: string | null;
  readonly emailForDisplay: string | null;
}

export type CasStackStatus = "active" | "suspended";

export interface CasStack {
  readonly stackId: CasStackId;
  readonly displayName: string;
  readonly description: string;
  readonly status: CasStackStatus;
  readonly createdAt: number;
  readonly revision: number;
}

export interface CasStackMember extends CasOperatorIdentityKey {
  readonly stackId: CasStackId;
  readonly displayName: string | null;
  readonly emailForDisplay: string | null;
}

/**
 * MVP membership is equal: every member has identical stack-admin authority.
 * There is no per-member RBAC grant on control-plane routes.
 */
export const CAS_STACK_MEMBER_AUTHORITY = "equal_administrator" as const;

export type CasMemberInvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export interface CasMemberInvitation {
  readonly invitationId: string;
  readonly stackId: CasStackId;
  readonly status: CasMemberInvitationStatus;
  readonly emailConstraint: string | null;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly revision: number;
}

export type CasOAuthIssuerMetadataType = "oauth" | "oidc";

export type CasOAuthIssuerStatus =
  | "pending"
  | "active"
  | "stale"
  | "incompatible"
  | "disabled";

/** Discovered Stack OAuth authorization-server binding. */
export interface CasStackOAuthIssuer {
  readonly stackId: CasStackId;
  readonly issuer: string;
  readonly audience: string;
  readonly metadataUrl: string;
  readonly metadataType: CasOAuthIssuerMetadataType;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly registrationEndpoint: string | null;
  readonly scopesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
  readonly status: CasOAuthIssuerStatus;
  readonly verifiedAt: number | null;
  readonly lastRefreshAt: number | null;
  readonly lastRefreshError: string | null;
  readonly jwksDigest: string;
  /** Per-stack capability signing cap in seconds (default 28800, max 604800). */
  readonly capabilityMaxLifetimeSeconds: number;
  readonly revision: number;
}

export interface CasOAuthIssuerInspectionKey {
  readonly kid: string;
  readonly algorithm: string;
  readonly publicJwk: Readonly<Record<string, unknown>>;
}

export interface CasOAuthIssuerInspection {
  readonly inspectionId: string;
  readonly stackId: CasStackId;
  readonly issuer: string;
  readonly audience: string;
  readonly metadataUrl: string;
  readonly metadataType: CasOAuthIssuerMetadataType;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly registrationEndpoint: string | null;
  readonly scopesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
  readonly metadataDigest: string;
  readonly jwksDigest: string;
  readonly capabilityMaxLifetimeSeconds: number;
  /** Exact bytes to sign as the compact-JWS payload for activation. */
  readonly challenge: string;
  readonly expiresAt: number;
  readonly keys: readonly CasOAuthIssuerInspectionKey[];
  /** Revision of the pending OAuth issuer resource. */
  readonly revision: number;
}

/** A refDomain observed in successful Root Ref audit writes. */
export interface CasRefDomain {
  readonly stackId: CasStackId;
  readonly refDomain: string;
  readonly revision: number;
}

export interface CasControlAuditEvent {
  readonly eventId: string;
  readonly stackId: CasStackId | null;
  readonly actor: CasOperatorIdentityKey;
  readonly action: string;
  readonly target: string;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly caller: {
    readonly channel: "admin-webui" | "mcp";
    readonly oauthClientHandle: string | null;
    readonly toolName: string | null;
  } | null;
  readonly createdAt: number;
}

/** Platform-operator actions are not stack-membership grants. */
export type CasPlatformOperatorAction =
  | "suspend_stack"
  | "unsuspend_stack"
  | "disaster_recovery";

export interface CasPlatformOperatorCapability {
  readonly action: CasPlatformOperatorAction;
  /**
   * Stack members cannot mint or grant these. Only CAS platform operators
   * hold them, through a plane disjoint from `/admin` stack membership.
   */
  readonly grantedByStackMembership: false;
}

export interface CasRootRefBalance {
  readonly tenantId: string;
  readonly hash: CasHash;
  readonly count: number;
}

export interface CasRootRefEvent {
  readonly revision: number;
  readonly tenantId: string;
  readonly requestId: string;
  readonly changes: CasRefChanges;
  readonly appliedAt: number;
}
