/**
 * CAS-neutral tenant capability contract.
 *
 * The stack-issued JWT capability claim shape shared by every stack issuer
 * (Gateway and any other issuer implementation): `iss, aud, sub, iat, nbf?,
 * exp, jti`, plus `tenantId`, `permissions[]` and an optional `refDomain` for
 * Root Refs writes. This is the tenant data-plane credential contract — the
 * CAS verifier and every stack authority produce/consume the same vocabulary.
 *
 * Formerly owned by `@unidocs/service-auth` (permissions/claims/errors);
 * moved here so the independently deployable CAS middleware owns its own
 * credential contract. `@unidocs/service-auth` re-exports these symbols for
 * the application stack (issuance/verification machinery stays there).
 */

import type { JWTHeaderParameters, JWTPayload } from "jose";

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

declare const capabilityPermissionBrand: unique symbol;

export type CapabilityPermission = string & {
  readonly [capabilityPermissionBrand]: true;
};

export type CapabilityPermissionKind =
  | "cas:read"
  | "cas:write"
  | "cas:manage"
  | "sessions:create"
  | "sessions:read"
  | "sessions:write";

export type ParsedCapabilityPermission = {
  readonly kind: CapabilityPermissionKind;
  readonly tenantId: string;
  readonly sessionId?: string;
};

export function canonicalPermissionSegment(value: string): string {
  if (value.length === 0) throw new TypeError("Capability resource IDs must not be empty");
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function casReadPermission(tenantId: string): CapabilityPermission {
  return tenantPermission(tenantId, "cas:read");
}

export function casWritePermission(tenantId: string): CapabilityPermission {
  return tenantPermission(tenantId, "cas:write");
}

export function casManagePermission(tenantId: string): CapabilityPermission {
  return tenantPermission(tenantId, "cas:manage");
}

export function sessionCreatePermission(tenantId: string): CapabilityPermission {
  return tenantPermission(tenantId, "sessions:create");
}

export function sessionReadPermission(
  tenantId: string,
  sessionId: string,
): CapabilityPermission {
  return sessionPermission(tenantId, sessionId, "read");
}

export function sessionWritePermission(
  tenantId: string,
  sessionId: string,
): CapabilityPermission {
  return sessionPermission(tenantId, sessionId, "write");
}

export function parseCapabilityPermission(
  permission: string,
): ParsedCapabilityPermission | null {
  const parts = permission.split(":");
  if (parts[0] !== "tenants") return null;
  const tenantId = decodeCanonicalSegment(parts[1]);
  if (tenantId === null) return null;

  if (parts.length === 4 && parts[2] === "cas") {
    const action = parts[3];
    if (action === "read" || action === "write") {
      return { kind: `cas:${action}`, tenantId };
    }
    if (action === "manage") {
      return { kind: "cas:manage", tenantId };
    }
    return null;
  }

  if (parts.length === 4 && parts[2] === "sessions" && parts[3] === "create") {
    return { kind: "sessions:create", tenantId };
  }

  if (parts.length === 5 && parts[2] === "sessions") {
    const sessionId = decodeCanonicalSegment(parts[3]);
    const action = parts[4];
    if (sessionId !== null && (action === "read" || action === "write")) {
      return { kind: `sessions:${action}`, tenantId, sessionId };
    }
  }

  return null;
}

export function hasCapabilityPermission(
  permissions: readonly string[],
  expected: CapabilityPermission,
): boolean {
  return permissions.includes(expected);
}

function tenantPermission(
  tenantId: string,
  suffix:
    | "cas:read"
    | "cas:write"
    | "cas:manage"
    | "sessions:create",
): CapabilityPermission {
  return `tenants:${canonicalPermissionSegment(tenantId)}:${suffix}` as CapabilityPermission;
}

function sessionPermission(
  tenantId: string,
  sessionId: string,
  action: "read" | "write",
): CapabilityPermission {
  return `tenants:${canonicalPermissionSegment(tenantId)}:sessions:${canonicalPermissionSegment(sessionId)}:${action}` as CapabilityPermission;
}

function decodeCanonicalSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && canonicalPermissionSegment(decoded) === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export const CapabilityVersion = 1 as const;
export const CapabilityAlgorithm = "ES256" as const;
export const CapabilityTokenType = "unidocs-cap+jwt" as const;
export const DefaultCapabilityLifetimeSeconds = 120;
/**
 * 一张 capability 最长能签多久。签发（issuer）和校验（verifier）两端
 * 都强制，也是 CAPABILITY_MAX_LIFETIME_SECONDS 的解析上界。
 *
 * 2026-08 从 300 抬到 1800：agent 的 /run 是一次可能跑几十分钟的循环，
 * operator 全程带着启动时那张 delegated-cas 凭据调编辑器，凭据一过期
 * 后续写入就 401。这是权宜之计 —— 代价是校验侧不再为 apply 这类短操作
 * 兜底，正解是循环中途续签。
 */
export const MaximumCapabilityLifetimeSeconds = 1800;
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CapabilityErrorCode =
  | "invalid_token"
  | "missing_token"
  | "insufficient_permission"
  | "resource_scope_mismatch"
  | "unknown_issuer"
  | "issuer_disabled"
  | "registry_unavailable"
  | "unsupported_algorithm";

export abstract class CapabilityError extends Error {
  abstract readonly status: 401 | 403;
  readonly code: CapabilityErrorCode;

  protected constructor(code: CapabilityErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class CapabilityAuthenticationError extends CapabilityError {
  readonly status = 401 as const;

  constructor(
    code:
      | "invalid_token"
      | "missing_token"
      | "unknown_issuer"
      | "issuer_disabled"
      | "registry_unavailable",
    message: string,
  ) {
    super(code, message);
    this.name = "CapabilityAuthenticationError";
  }
}

export class CapabilityAuthorizationError extends CapabilityError {
  readonly status = 403 as const;

  constructor(
    code:
      | "insufficient_permission"
      | "resource_scope_mismatch"
      | "unsupported_algorithm"
      | "registry_unavailable",
    message: string,
  ) {
    super(code, message);
    this.name = "CapabilityAuthorizationError";
  }
}
