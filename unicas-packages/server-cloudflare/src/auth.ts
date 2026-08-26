/**
 * Stack-scoped tenant authorization for the canonical CAS server.
 *
 * Resolves a verified issuer to its stack authority through the read-only
 * `AuthorityRepository` (never a token-supplied JWKS URL), verifies the
 * capability (algorithm, exact issuer, stack audience, lifetime, tenant,
 * permissions, optional refDomain), then requires issuer-derived stack
 * equality and token-tenant equality with the request path BEFORE any storage
 * access. `sub` is an opaque audit identity — no Gateway/Doc subject-prefix
 * semantics. Registry records are cached 30s and never served past the 60s
 * hard stale bound; an unavailable registry fails closed. A static legacy
 * stack bootstrap covers the migration window.
 */

import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import type { JSONWebKeySet } from "jose";
import type { CasRoute } from "@unicas/protocol";
import type {
  AuthorityRepository,
  RegisteredRefDomain,
  ResolvedStackAuthority,
} from "@unicas/control-plane";
import {
  CapabilityAlgorithm,
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  casGcTriggerPermission,
  casReadPermission,
  casUsageReadPermission,
  casWritePermission,
  isReservedRefDomain,
} from "@unidocs/service-auth";

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

export interface StaticLegacyStackConfig {
  readonly stackId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly algorithm: string;
  readonly jwks: JSONWebKeySet;
}

export interface StackVerifierOptions {
  readonly repository: AuthorityRepository;
  /** Allowed algorithms; default [ES256]. */
  readonly allowedAlgorithms?: readonly string[];
  /** Serve cached authority records for this long without a registry read. */
  readonly cacheTtlMs?: number;
  /** Hard bound after which a cached record is never used (revocation bound). */
  readonly hardStaleBoundMs?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: StackAuthEvent) => void;
  /** Bootstrap for one operator-selected legacy stack during migration. */
  readonly staticLegacyStack?: StaticLegacyStackConfig;
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

export class StackCapabilityVerifier {
  readonly #repository: AuthorityRepository;
  readonly #algorithms: string[];
  readonly #cacheTtlMs: number;
  readonly #hardStaleBoundMs: number;
  readonly #now: () => number;
  readonly #onEvent: (event: StackAuthEvent) => void;
  readonly #staticLegacyStack: StaticLegacyStackConfig | null;
  readonly #authorityCache = new Map<string, CachedAuthority>();
  readonly #domainsCache = new Map<string, CachedDomains>();

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
    this.#staticLegacyStack = options.staticLegacyStack ?? null;
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

    // Parse unverified iss/kid only as lookup keys; never trust anything else
    // from the token before verification.
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
    if (authority.status !== "active") {
      throw new CapabilityAuthenticationError("issuer_disabled", "CAS capability issuer is disabled");
    }

    const keySet = createLocalJWKSet(stackJwks(authority));
    let payload: Omit<VerifiedPayload, "stackId" | "kid">;
    try {
      const result = await jwtVerify(token, keySet, {
        algorithms: this.#algorithms,
        issuer: authority.issuer,
        audience: authority.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(this.#now()),
        requiredClaims: ["sub", "iat", "nbf", "exp", "jti", "tenantId", "permissions"],
      });
      payload = normalizePayload(result.payload);
    } catch (error) {
      if (error instanceof CapabilityAuthenticationError
        || error instanceof CapabilityAuthorizationError) {
        throw error;
      }
      throw new CapabilityAuthenticationError("invalid_token", "CAS capability token verification failed");
    }

    // Issuer-derived stack must equal the path stack; token tenant the path tenant.
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
      refDomain = await this.#requireRegisteredActiveDomain(route, payload);
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
        // Hard bound: never serve the cached record past the revocation
        // bound, but a REACHABLE registry should serve a fresh record —
        // failing closed unconditionally would 401 healthy low-traffic
        // stacks on every request after ~60s of silence.
        try {
          const fresh = await this.#repository.resolveIssuer(issuer);
          if (fresh) {
            this.#authorityCache.set(issuer, { authority: fresh, fetchedAt: now });
            return fresh;
          }
          // Registry answered: the issuer is gone (revoked/removed) → fail closed.
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
      // Within the stale window: try to refresh; serve the cached record only
      // if the registry is unreachable.
      try {
        const fresh = await this.#repository.resolveIssuer(issuer);
        if (fresh) {
          this.#authorityCache.set(issuer, { authority: fresh, fetchedAt: now });
          return fresh;
        }
        // Registry answered: the issuer is gone (revoked/removed) → fail closed.
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
    const authority = (await this.#repository.resolveIssuer(issuer).catch(() => null))
      ?? this.#staticLegacy(issuer);
    if (!authority) return null;
    this.#authorityCache.set(issuer, { authority, fetchedAt: now });
    return authority;
  }

  async #requireRegisteredActiveDomain(
    route: CasRoute & { operation: "updateRootRefs" },
    payload: Omit<VerifiedPayload, "stackId" | "kid">,
  ): Promise<string> {
    const claimed = payload.refDomain;
    if (typeof claimed !== "string" || claimed.length === 0) {
      throw new CapabilityAuthorizationError("resource_scope_mismatch", "Root Refs write requires a refDomain claim");
    }
    if (isReservedRefDomain(claimed)) {
      throw new CapabilityAuthorizationError("resource_scope_mismatch", `refDomain '${claimed}' is reserved`);
    }
    const domains = await this.#resolveDomains(route.stackId);
    const registered = domains.find((domain) => domain.refDomain === claimed);
    if (!registered || registered.status !== "active") {
      throw new CapabilityAuthorizationError("resource_scope_mismatch", `refDomain '${claimed}' is not registered and active`);
    }
    return claimed;
  }

  async #resolveDomains(stackId: string): Promise<readonly RegisteredRefDomain[]> {
    const now = this.#now();
    const cached = this.#domainsCache.get(stackId);
    if (cached) {
      const age = now - cached.fetchedAt;
      if (age < this.#cacheTtlMs) return cached.domains;
      if (age >= this.#hardStaleBoundMs) {
        // Hard bound: never serve cached domains past the revocation bound,
        // but a REACHABLE registry serves a fresh list — failing closed
        // unconditionally would 403 every root-refs write on low-traffic
        // stacks after ~60s of silence.
        try {
          const fresh = await this.#repository.listRegisteredRefDomains(stackId);
          this.#domainsCache.set(stackId, { domains: fresh, fetchedAt: now });
          return fresh;
        } catch {
          this.#domainsCache.delete(stackId);
          this.#onEvent({
            kind: "fail_closed",
            operation: "unknown",
            stackId,
            reason: "refDomain registry unreachable past the hard stale bound",
          });
          throw new CapabilityAuthorizationError("registry_unavailable", "CAS refDomain registry is unavailable");
        }
      }
      try {
        const fresh = await this.#repository.listRegisteredRefDomains(stackId);
        this.#domainsCache.set(stackId, { domains: fresh, fetchedAt: now });
        return fresh;
      } catch {
        this.#onEvent({
          kind: "registry_stale",
          operation: "unknown",
          stackId,
          reason: "refDomain registry unreachable; serving cached domains within the stale bound",
        });
        return cached.domains;
      }
    }
    const domains = await this.#repository.listRegisteredRefDomains(stackId);
    this.#domainsCache.set(stackId, { domains, fetchedAt: now });
    return domains;
  }

  #staticLegacy(issuer: string): ResolvedStackAuthority | null {
    const staticConfig = this.#staticLegacyStack;
    if (!staticConfig || staticConfig.issuer !== issuer) return null;
    return {
      stackId: staticConfig.stackId,
      issuer: staticConfig.issuer,
      audience: staticConfig.audience,
      status: "active",
      keys: staticConfig.jwks.keys.map((key) => ({
        kid: typeof key.kid === "string" ? key.kid : "",
        algorithm: staticConfig.algorithm,
        publicJwk: key as Record<string, unknown>,
        state: "active" as const,
      })),
    };
  }
}

/** Exact operation → permission matrix. */
export function permissionFor(route: CasRoute): string {
  switch (route.operation) {
    case "readContent":
    case "readMetadata":
      return casReadPermission(route.tenantId);
    case "leaseNode":
    case "leaseExisting":
    case "updateRootRefs":
      return casWritePermission(route.tenantId);
    case "usage":
      return casUsageReadPermission(route.tenantId);
    case "gc":
      return casGcTriggerPermission(route.tenantId);
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

interface CachedDomains {
  readonly domains: readonly RegisteredRefDomain[];
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
  sub?: unknown;
  jti?: unknown;
  tenantId?: unknown;
  permissions?: unknown;
  iss?: unknown;
  refDomain?: unknown;
}): Omit<VerifiedPayload, "stackId" | "kid"> {
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
