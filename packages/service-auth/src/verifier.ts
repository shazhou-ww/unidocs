import { createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTPayload } from "jose";
import {
  CapabilityAlgorithm,
  CapabilityTokenType,
  CapabilityVersion,
  MaximumCapabilityClockSkewSeconds,
  MaximumCapabilityLifetimeSeconds,
  validateRefDomainClaim,
} from "./claims.js";
import type {
  CapabilityClaims,
  CapabilityProtectedHeader,
  VerifiedCapability,
} from "./claims.js";
import {
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  CapabilityError,
} from "./errors.js";
import type {
  CapabilityPermission,
  CapabilityPermissionKind,
} from "./permissions.js";
import {
  hasCapabilityPermission,
  parseCapabilityPermission,
} from "./permissions.js";

const AllowedClaimNames = new Set([
  "ver",
  "iss",
  "sub",
  "aud",
  "iat",
  "nbf",
  "exp",
  "jti",
  "tenantId",
  "sessionId",
  "permissions",
  "refDomain",
]);

export interface CapabilityVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithm: typeof CapabilityAlgorithm;
  readonly jwks: JSONWebKeySet;
  readonly allowedPermissionKinds: readonly CapabilityPermissionKind[];
  readonly allowedSubjects?: readonly string[];
  readonly maximumLifetimeSeconds?: number;
  readonly clockSkewSeconds?: number;
  readonly now?: () => number;
}

export class CapabilityVerifier {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #allowedPermissionKinds: ReadonlySet<CapabilityPermissionKind>;
  readonly #allowedSubjects: ReadonlySet<string> | null;
  readonly #maximumLifetimeSeconds: number;
  readonly #clockSkewSeconds: number;
  readonly #now: () => number;
  readonly #keySet: ReturnType<typeof createLocalJWKSet>;

  constructor(config: CapabilityVerifierConfig) {
    requireConfiguredString(config.issuer, "Capability issuer");
    requireConfiguredString(config.audience, "Capability audience");
    if (config.algorithm !== CapabilityAlgorithm) {
      throw new TypeError(`Capability verifier must use ${CapabilityAlgorithm}`);
    }
    if (config.jwks.keys.length === 0) {
      throw new TypeError("Capability JWKS must contain at least one public key");
    }
    const keyIds = new Set<string>();
    const keys = config.jwks.keys.map((key) => {
      if (typeof key.kid !== "string" || key.kid.length === 0) {
        throw new TypeError("Every capability JWK must have a key ID");
      }
      if (keyIds.has(key.kid)) throw new TypeError("Capability JWK key IDs must be unique");
      if ("d" in key) throw new TypeError("Capability verifier JWKS must not contain private keys");
      keyIds.add(key.kid);
      return { ...key };
    });
    if (config.allowedPermissionKinds.length === 0) {
      throw new TypeError("Capability verifier must allow at least one permission kind");
    }

    const maximumLifetimeSeconds = config.maximumLifetimeSeconds
      ?? MaximumCapabilityLifetimeSeconds;
    const clockSkewSeconds = config.clockSkewSeconds
      ?? MaximumCapabilityClockSkewSeconds;
    requireIntegerRange(
      maximumLifetimeSeconds,
      1,
      MaximumCapabilityLifetimeSeconds,
      "Maximum capability lifetime",
    );
    requireIntegerRange(
      clockSkewSeconds,
      0,
      MaximumCapabilityClockSkewSeconds,
      "Capability clock skew",
    );

    this.#issuer = config.issuer;
    this.#audience = config.audience;
    this.#allowedPermissionKinds = new Set(config.allowedPermissionKinds);
    this.#allowedSubjects = config.allowedSubjects
      ? new Set(config.allowedSubjects)
      : null;
    this.#maximumLifetimeSeconds = maximumLifetimeSeconds;
    this.#clockSkewSeconds = clockSkewSeconds;
    this.#now = config.now ?? (() => Date.now() / 1000);
    this.#keySet = createLocalJWKSet({ keys });
  }

  async verify(token: string): Promise<VerifiedCapability> {
    if (token.length === 0) {
      throw new CapabilityAuthenticationError("missing_token", "Capability token is required");
    }

    try {
      const now = Math.floor(this.#now());
      if (!Number.isSafeInteger(now)) {
        throw new CapabilityAuthenticationError("invalid_token", "Capability clock is invalid");
      }
      const result = await jwtVerify(token, this.#keySet, {
        algorithms: [CapabilityAlgorithm],
        issuer: this.#issuer,
        audience: this.#audience,
        typ: CapabilityTokenType,
        clockTolerance: this.#clockSkewSeconds,
        maxTokenAge: this.#maximumLifetimeSeconds,
        currentDate: new Date(now * 1000),
        requiredClaims: ["sub", "iat", "nbf", "exp", "jti"],
      });
      const protectedHeader = validateProtectedHeader(result.protectedHeader);
      const claims = this.#validateClaims(result.payload, now);
      return Object.freeze({ protectedHeader, claims });
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityAuthenticationError(
        "invalid_token",
        "Capability token is invalid",
      );
    }
  }

  #validateClaims(payload: JWTPayload, now: number): CapabilityClaims {
    for (const name of Object.keys(payload)) {
      if (!AllowedClaimNames.has(name)) invalidToken("Capability contains an unsupported claim");
    }
    if (payload.ver !== CapabilityVersion) invalidToken("Capability version is invalid");
    if (payload.iss !== this.#issuer) invalidToken("Capability issuer is invalid");
    if (payload.aud !== this.#audience) invalidToken("Capability audience is invalid");
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      invalidToken("Capability subject is invalid");
    }
    if (this.#allowedSubjects && !this.#allowedSubjects.has(payload.sub)) {
      invalidToken("Capability subject is invalid");
    }
    if (typeof payload.jti !== "string" || payload.jti.length === 0) {
      invalidToken("Capability token ID is invalid");
    }
    if (typeof payload.tenantId !== "string" || payload.tenantId.length === 0) {
      invalidToken("Capability tenant ID is invalid");
    }
    const sessionId = payload.sessionId;
    if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0)) {
      invalidToken("Capability session ID is invalid");
    }

    const refDomain = payload.refDomain;
    if (refDomain !== undefined) {
      const domainError = validateRefDomainClaim(refDomain);
      if (domainError) invalidToken(`Capability refDomain is invalid: ${domainError}`);
    }

    const issuedAt = requireNumericDate(payload.iat, "issued-at");
    const notBefore = requireNumericDate(payload.nbf, "not-before");
    const expiresAt = requireNumericDate(payload.exp, "expiration");
    if (expiresAt <= issuedAt || notBefore > expiresAt) {
      invalidToken("Capability lifetime is invalid");
    }
    if (expiresAt - issuedAt > this.#maximumLifetimeSeconds) {
      invalidToken("Capability lifetime exceeds the configured maximum");
    }
    if (issuedAt > now + this.#clockSkewSeconds) {
      invalidToken("Capability issued-at time is in the future");
    }

    if (!Array.isArray(payload.permissions) || payload.permissions.length === 0) {
      invalidToken("Capability permissions are invalid");
    }
    const permissions: CapabilityPermission[] = [];
    const uniquePermissions = new Set<string>();
    for (const value of payload.permissions) {
      if (typeof value !== "string") invalidToken("Capability permissions are invalid");
      const parsed = parseCapabilityPermission(value);
      if (!parsed || parsed.tenantId !== payload.tenantId) {
        invalidToken("Capability permission resource is invalid");
      }
      if (parsed.sessionId !== undefined && parsed.sessionId !== sessionId) {
        invalidToken("Capability permission session is invalid");
      }
      if (parsed.kind.startsWith("sessions:") && sessionId === undefined) {
        invalidToken("Session permission requires a session claim");
      }
      if (parsed.kind === "cas:admin" && sessionId !== undefined) {
        throw new CapabilityAuthorizationError(
          "insufficient_permission",
          "Session capabilities cannot contain CAS administration permission",
        );
      }
      if (!this.#allowedPermissionKinds.has(parsed.kind)) {
        throw new CapabilityAuthorizationError(
          "insufficient_permission",
          "Capability contains a permission that is not accepted by this service",
        );
      }
      if (uniquePermissions.has(value)) {
        invalidToken("Capability permissions contain duplicates");
      }
      uniquePermissions.add(value);
      permissions.push(value as CapabilityPermission);
    }

    return Object.freeze({
      ver: CapabilityVersion,
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
      iat: issuedAt,
      nbf: notBefore,
      exp: expiresAt,
      jti: payload.jti,
      tenantId: payload.tenantId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(refDomain === undefined ? {} : { refDomain }),
      permissions: Object.freeze(permissions),
    }) as CapabilityClaims;
  }
}

export function requireCapabilityPermission(
  capability: VerifiedCapability,
  permission: CapabilityPermission,
): void {
  if (!hasCapabilityPermission(capability.claims.permissions, permission)) {
    throw new CapabilityAuthorizationError(
      "insufficient_permission",
      "Capability does not grant the required permission",
    );
  }
}

export function requireCapabilityTenant(
  capability: VerifiedCapability,
  tenantId: string,
): void {
  if (capability.claims.tenantId !== tenantId) {
    throw new CapabilityAuthorizationError(
      "resource_scope_mismatch",
      "Capability tenant does not match the requested resource",
    );
  }
}

export function requireCapabilitySession(
  capability: VerifiedCapability,
  sessionId: string,
): void {
  if (capability.claims.sessionId !== sessionId) {
    throw new CapabilityAuthorizationError(
      "resource_scope_mismatch",
      "Capability session does not match the requested resource",
    );
  }
}

export function extractBearerCapability(authorization: string | null): string {
  if (!authorization) {
    throw new CapabilityAuthenticationError("missing_token", "Capability token is required");
  }
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) {
    throw new CapabilityAuthenticationError(
      "invalid_token",
      "Capability authorization header is invalid",
    );
  }
  return match[1];
}

function validateProtectedHeader(header: JWTPayload): CapabilityProtectedHeader {
  if (Object.keys(header).some(name => name !== "alg" && name !== "kid" && name !== "typ")) {
    invalidToken("Capability protected header is invalid");
  }
  if (header.alg !== CapabilityAlgorithm
    || header.typ !== CapabilityTokenType
    || typeof header.kid !== "string"
    || header.kid.length === 0) {
    invalidToken("Capability protected header is invalid");
  }
  return Object.freeze({
    alg: CapabilityAlgorithm,
    kid: header.kid,
    typ: CapabilityTokenType,
  });
}

function requireNumericDate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    invalidToken(`Capability ${label} claim is invalid`);
  }
  return value;
}

function invalidToken(message: string): never {
  throw new CapabilityAuthenticationError("invalid_token", message);
}

function requireConfiguredString(value: string, label: string): void {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
}

function requireIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}