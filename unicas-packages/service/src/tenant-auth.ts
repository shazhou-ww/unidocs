import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import type { JSONWebKeySet } from "jose";
import {
  CapabilityAlgorithm,
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  CapabilityVersion,
  casManagePermission,
  casReadPermission,
  casWritePermission,
  validateRefDomainClaim,
  type CasRoute,
} from "@unicas/tenant-protocol";

export interface RegisteredStackKey {
  readonly kid: string;
  readonly algorithm: string;
  readonly publicJwk: Record<string, unknown>;
  readonly state: "active" | "retiring" | "revoked";
}

/** Cloud-neutral authority data required to verify a tenant capability. */
export interface ResolvedStackAuthority {
  readonly stackId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly capabilityMaxLifetimeSeconds: number;
  readonly keys: readonly RegisteredStackKey[];
}

/** Read-only authority lookup port. Platform adapters own its persistence. */
export interface StackAuthorityResolver {
  resolveIssuer(issuer: string): Promise<ResolvedStackAuthority | null>;
}

export interface StackAuthEvent {
  readonly kind: "authorized" | "rejected" | "registry_stale" | "fail_closed";
  readonly operation: CasRoute["operation"] | "unknown";
  readonly stackId?: string;
  readonly tenantId?: string;
  readonly issuer?: string;
  readonly kid?: string;
  readonly jti?: string;
  readonly reason?: string;
}

export interface StackVerifierOptions {
  readonly repository: StackAuthorityResolver;
  /** Allowed algorithms; default [ES256]. */
  readonly allowedAlgorithms?: readonly string[];
  /** Serve cached authority records for this long without a registry read. */
  readonly cacheTtlMs?: number;
  /** Hard bound after which a cached record is never used (revocation bound). */
  readonly hardStaleBoundMs?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: StackAuthEvent) => void;
}

export interface VerifiedStackCall {
  readonly stackId: string;
  readonly tenantId: string;
  /** Opaque audit identity; CAS never interprets subject prefixes. */
  readonly subject: string;
  readonly jti: string;
  readonly kid: string;
  readonly permissions: readonly string[];
  /** Only present on Root Refs writes. */
  readonly refDomain?: string;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_HARD_STALE_BOUND_MS = 60_000;
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Verifies stack-scoped tenant capabilities without depending on a platform
 * database or runtime. Issuer records are cached for 30 seconds and are never
 * served past the 60-second hard stale bound when the registry is unavailable.
 */
export class StackCapabilityVerifier {
  readonly #repository: StackAuthorityResolver;
  readonly #algorithms: string[];
  readonly #cacheTtlMs: number;
  readonly #hardStaleBoundMs: number;
  readonly #now: () => number;
  readonly #onEvent: (event: StackAuthEvent) => void;
  readonly #authorityCache = new Map<string, CachedAuthority>();

  constructor(options: StackVerifierOptions) {
    this.#repository = options.repository;
    this.#algorithms = [...(options.allowedAlgorithms ?? [CapabilityAlgorithm])];
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#hardStaleBoundMs = options.hardStaleBoundMs ?? DEFAULT_HARD_STALE_BOUND_MS;
    if (this.#cacheTtlMs >= this.#hardStaleBoundMs) {
      throw new TypeError("cacheTtlMs must be below hardStaleBoundMs");
    }
    this.#now = options.now ?? (() => Date.now());
    this.#onEvent = options.onEvent ?? (() => undefined);
  }

  async verify(request: Request, route: CasRoute): Promise<VerifiedStackCall> {
    let capability: VerifiedPayload;
    try {
      capability = await this.#verifyToken(request, route);
    } catch (error) {
      this.#onEvent({
        kind: "rejected",
        operation: route.operation,
        stackId: route.stackId,
        tenantId: route.tenantId,
        reason: error instanceof Error ? error.message : "authorization failed",
      });
      throw error;
    }
    this.#onEvent({
      kind: "authorized",
      operation: route.operation,
      stackId: capability.stackId,
      tenantId: capability.tenantId,
      issuer: capability.issuer,
      kid: capability.kid,
      jti: capability.jti,
    });
    return {
      stackId: capability.stackId,
      tenantId: capability.tenantId,
      subject: capability.subject,
      jti: capability.jti,
      kid: capability.kid,
      permissions: capability.permissions,
      ...(capability.refDomain === undefined ? {} : { refDomain: capability.refDomain }),
    };
  }

  async #verifyToken(request: Request, route: CasRoute): Promise<VerifiedPayload> {
    const authorization = request.headers.get("Authorization");
    if (!authorization) {
      throw new CapabilityAuthenticationError("missing_token", "CAS capability token is required");
    }
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) {
      throw new CapabilityAuthenticationError("invalid_token", "CAS authorization header is invalid");
    }
    const token = match[1]!;

    let unverifiedIss: unknown;
    let kid: string | undefined;
    let alg: string | undefined;
    try {
      unverifiedIss = decodeJwt(token).iss;
      const header = decodeProtectedHeader(token);
      kid = typeof header.kid === "string" ? header.kid : undefined;
      alg = typeof header.alg === "string" ? header.alg : undefined;
    } catch {
      throw new CapabilityAuthenticationError("invalid_token", "CAS capability token is malformed");
    }
    if (typeof unverifiedIss !== "string" || unverifiedIss.length === 0 || !kid || !alg) {
      throw new CapabilityAuthenticationError("invalid_token", "CAS capability token is missing issuer or key id");
    }
    if (!this.#algorithms.includes(alg)) {
      throw new CapabilityAuthorizationError("unsupported_algorithm", `CAS capability algorithm ${alg} is not allowed`);
    }

    const authority = await this.#resolveAuthority(unverifiedIss);
    if (!authority) {
      throw new CapabilityAuthenticationError("unknown_issuer", "CAS capability issuer is not registered");
    }
    const keySet = createLocalJWKSet(stackJwks(authority));
    let payload: Omit<VerifiedPayload, "stackId" | "kid">;
    let lifetimeSeconds = 0;
    try {
      const result = await jwtVerify(token, keySet, {
        algorithms: this.#algorithms,
        issuer: authority.issuer,
        audience: authority.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(this.#now()),
        requiredClaims: ["ver", "sub", "iat", "nbf", "exp", "jti", "tenantId", "permissions"],
      });
      payload = normalizePayload(result.payload);
      lifetimeSeconds = Number(result.payload.exp) - Number(result.payload.iat);
    } catch (error) {
      if (error instanceof CapabilityAuthenticationError
        || error instanceof CapabilityAuthorizationError) {
        throw error;
      }
      throw new CapabilityAuthenticationError("invalid_token", "CAS capability token verification failed");
    }

    if (lifetimeSeconds > authority.capabilityMaxLifetimeSeconds) {
      throw new CapabilityAuthenticationError("invalid_token", "CAS capability lifetime exceeds the stack's configured maximum");
    }
    if (authority.stackId !== route.stackId) {
      throw new CapabilityAuthorizationError("resource_scope_mismatch", "CAS capability stack does not match the requested path");
    }
    if (payload.tenantId !== route.tenantId) {
      throw new CapabilityAuthorizationError("resource_scope_mismatch", "CAS capability tenant does not match the requested path");
    }

    const permission = permissionFor(route);
    if (!payload.permissions.includes(permission)) {
      throw new CapabilityAuthorizationError("insufficient_permission", `CAS ${route.operation} requires ${permission}`);
    }

    let refDomain: string | undefined;
    if (route.operation === "updateRootRefs") {
      refDomain = this.#requireValidRefDomain(payload);
    }
    return { ...payload, stackId: authority.stackId, kid, refDomain };
  }

  async #resolveAuthority(issuer: string): Promise<ResolvedStackAuthority | null> {
    const now = this.#now();
    const cached = this.#authorityCache.get(issuer);
    if (cached) {
      const age = now - cached.fetchedAt;
      if (age < this.#cacheTtlMs) return cached.authority;
      if (age >= this.#hardStaleBoundMs) {
        try {
          const fresh = await this.#repository.resolveIssuer(issuer);
          if (fresh) {
            this.#authorityCache.set(issuer, { authority: fresh, fetchedAt: now });
            return fresh;
          }
          this.#authorityCache.delete(issuer);
          throw new CapabilityAuthenticationError("unknown_issuer", "CAS capability issuer is not registered");
        } catch (error) {
          if (error instanceof CapabilityAuthenticationError) throw error;
          this.#authorityCache.delete(issuer);
          this.#onEvent({
            kind: "fail_closed",
            operation: "unknown",
            issuer,
            reason: "authority registry unreachable past the hard stale bound",
          });
          throw new CapabilityAuthenticationError("registry_unavailable", "CAS authority registry is unavailable");
        }
      }
      try {
        const fresh = await this.#repository.resolveIssuer(issuer);
        if (fresh) {
          this.#authorityCache.set(issuer, { authority: fresh, fetchedAt: now });
          return fresh;
        }
        this.#authorityCache.delete(issuer);
        throw new CapabilityAuthenticationError("unknown_issuer", "CAS capability issuer is not registered");
      } catch (error) {
        if (error instanceof CapabilityAuthenticationError) throw error;
        this.#onEvent({
          kind: "registry_stale",
          operation: "unknown",
          issuer,
          reason: "authority registry unreachable; serving cached record within the stale bound",
        });
        return cached.authority;
      }
    }
    const authority = await this.#repository.resolveIssuer(issuer).catch(() => null);
    if (!authority) return null;
    this.#authorityCache.set(issuer, { authority, fetchedAt: now });
    return authority;
  }

  #requireValidRefDomain(payload: Omit<VerifiedPayload, "stackId" | "kid">): string {
    const claimed = payload.refDomain;
    if (claimed === undefined) {
      throw new CapabilityAuthorizationError("resource_scope_mismatch", "Root Refs write requires a refDomain claim");
    }
    const error = validateRefDomainClaim(claimed);
    if (error) {
      throw new CapabilityAuthorizationError("resource_scope_mismatch", error);
    }
    return claimed;
  }
}

/** Exact operation-to-permission matrix. */
export function permissionFor(route: CasRoute): string {
  switch (route.operation) {
    case "readContent":
    case "readMetadata":
      return casReadPermission(route.tenantId);
    case "lease":
    case "updateRootRefs":
      return casWritePermission(route.tenantId);
    case "usage":
    case "gc":
      return casManagePermission(route.tenantId);
  }
}

interface VerifiedPayload {
  readonly subject: string;
  readonly jti: string;
  readonly tenantId: string;
  readonly permissions: readonly string[];
  readonly issuer: string;
  readonly refDomain?: string;
  readonly stackId: string;
  readonly kid: string;
}

interface CachedAuthority {
  readonly authority: ResolvedStackAuthority;
  readonly fetchedAt: number;
}

function stackJwks(authority: ResolvedStackAuthority): JSONWebKeySet {
  return {
    keys: authority.keys
      .filter((key) => key.state === "active" || key.state === "retiring")
      .map((key) => ({
        ...key.publicJwk,
        kid: key.kid,
        alg: key.algorithm,
        use: "sig",
      })),
  };
}

function normalizePayload(payload: {
  ver?: unknown;
  sub?: unknown;
  jti?: unknown;
  tenantId?: unknown;
  permissions?: unknown;
  iss?: unknown;
  refDomain?: unknown;
}): Omit<VerifiedPayload, "stackId" | "kid"> {
  if (payload.ver !== CapabilityVersion) {
    throw new CapabilityAuthenticationError("invalid_token", `CAS capability version is invalid (expected ${CapabilityVersion})`);
  }
  if (
    typeof payload.sub !== "string" || payload.sub.length === 0
    || typeof payload.jti !== "string" || payload.jti.length === 0
    || typeof payload.tenantId !== "string" || payload.tenantId.length === 0
    || typeof payload.iss !== "string"
    || !Array.isArray(payload.permissions)
    || payload.permissions.some((permission) => typeof permission !== "string")
  ) {
    throw new CapabilityAuthenticationError("invalid_token", "CAS capability claims are invalid");
  }
  const refDomain = payload.refDomain;
  if (refDomain !== undefined && typeof refDomain !== "string") {
    throw new CapabilityAuthenticationError("invalid_token", "CAS capability refDomain is invalid");
  }
  return {
    subject: payload.sub,
    jti: payload.jti,
    tenantId: payload.tenantId,
    permissions: payload.permissions as readonly string[],
    issuer: payload.iss,
    ...(typeof refDomain === "string" ? { refDomain } : {}),
  };
}
