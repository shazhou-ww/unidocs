import type { CasRoute } from "@unidocs/protocol-cas";
import {
  CapabilityAlgorithm,
  CapabilityAuthenticationError,
  CapabilityAuthorizationError,
  CapabilityVerifier,
  extractBearerCapability,
  parseCapabilityRuntimePolicy,
  requireCapabilityPermission,
  requireCapabilityTenant,
} from "@unidocs/service-auth";
import type {
  CapabilityRuntimePolicyBindings,
  CapabilityPermission,
  CapabilityVerifierConfig,
  VerifiedCapability,
} from "@unidocs/service-auth";
import {
  casAdminPermission,
  casReadPermission,
  casWritePermission,
} from "@unidocs/service-auth";

export type CasInternalAuthMode = "legacy" | "dual" | "capability";

export interface CasAuthBindings extends CapabilityRuntimePolicyBindings {
  readonly INTERNAL_AUTH_MODE?: string;
  readonly CAS_ACCESS_KEY?: string;
  readonly CAPABILITY_TRUSTED_JWKS?: string;
  readonly CAPABILITY_ISSUER?: string;
  readonly CAS_CAPABILITY_AUDIENCE?: string;
}

export interface CasRouteAuthorization {
  readonly capability?: VerifiedCapability;
}

export class CasAuthConfigCache {
  readonly #resolved = new WeakMap<object, CasAuthConfig>();

  get(bindings: CasAuthBindings): CasAuthConfig {
    const key = bindings as object;
    let resolved = this.#resolved.get(key);
    if (!resolved) {
      resolved = new CasAuthConfig(bindings);
      this.#resolved.set(key, resolved);
    }
    return resolved;
  }
}

export class CasAuthConfig {
  readonly mode: CasInternalAuthMode;
  readonly #accessKey: string | undefined;
  readonly #verifier: CapabilityVerifier | undefined;

  constructor(bindings: CasAuthBindings) {
    this.mode = parseMode(bindings.INTERNAL_AUTH_MODE);
    if (this.mode === "legacy" || this.mode === "dual") {
      this.#accessKey = requireBinding(bindings.CAS_ACCESS_KEY, "CAS_ACCESS_KEY");
    }
    if (this.mode === "capability" || this.mode === "dual") {
      const policy = parseCapabilityRuntimePolicy(bindings);
      this.#verifier = new CapabilityVerifier({
        issuer: requireBinding(bindings.CAPABILITY_ISSUER, "CAPABILITY_ISSUER"),
        audience: requireBinding(
          bindings.CAS_CAPABILITY_AUDIENCE,
          "CAS_CAPABILITY_AUDIENCE",
        ),
        algorithm: CapabilityAlgorithm,
        jwks: parseJwks(requireBinding(
          bindings.CAPABILITY_TRUSTED_JWKS,
          "CAPABILITY_TRUSTED_JWKS",
        )),
        allowedPermissionKinds: ["cas:read", "cas:write", "cas:admin"],
        maximumLifetimeSeconds: policy.maximumLifetimeSeconds,
        clockSkewSeconds: policy.clockSkewSeconds,
      });
    }
  }

  authenticateLegacy(request: Request): void {
    if (this.mode === "capability") {
      throw new CapabilityAuthenticationError("invalid_token", "Legacy CAS credentials are disabled");
    }
    if (request.headers.get("X-Internal-Token") !== this.#accessKey) {
      throw new CapabilityAuthenticationError("invalid_token", "Legacy CAS credential is invalid");
    }
  }

  async authorizeCapability(
    request: Request,
    route: CasRoute,
  ): Promise<CasRouteAuthorization> {
    if (this.mode === "legacy") {
      throw new CapabilityAuthenticationError("invalid_token", "CAS capabilities are disabled");
    }
    const token = extractBearerCapability(request.headers.get("Authorization"));
    const capability = await this.#verifier!.verify(token);
    requireCapabilityTenant(capability, route.tenantId);
    const permission = routePermission(route);
    requireCapabilityPermission(capability, permission);
    enforceSubjectAndSession(capability, route);
    return { capability };
  }
}

export function routePermission(route: CasRoute): CapabilityPermission {
  switch (route.operation) {
    case "readContent":
    case "readMetadata":
    case "readPortableNode":
      return casReadPermission(route.tenantId);
    case "leaseNode":
    case "leaseExisting":
    case "leasePortableNode":
    case "rootRefs":
    case "rootAssignments":
      return casWritePermission(route.tenantId);
    case "usage":
    case "gc":
      return casAdminPermission(route.tenantId);
  }
}

function enforceSubjectAndSession(
  capability: VerifiedCapability,
  route: CasRoute,
): void {
  const sessionId = capability.claims.sessionId;
  if (route.operation === "rootRefs" || route.operation === "rootAssignments") {
    if (!sessionId || !capability.claims.sub.startsWith("doc:")) {
      throw new CapabilityAuthorizationError(
        "resource_scope_mismatch",
        "CAS root operations require a Doc session capability",
      );
    }
    return;
  }
  if (route.operation === "usage" || route.operation === "gc") {
    if (sessionId !== undefined || capability.claims.sub !== "gateway") {
      throw new CapabilityAuthorizationError(
        "resource_scope_mismatch",
        "CAS administration requires a tenant-only Gateway capability",
      );
    }
    return;
  }
  if (sessionId === undefined && capability.claims.sub !== "gateway") {
    throw new CapabilityAuthorizationError(
      "resource_scope_mismatch",
      "Tenant CAS capabilities must be issued to Gateway",
    );
  }
  if (sessionId !== undefined && !capability.claims.sub.startsWith("doc:")) {
    throw new CapabilityAuthorizationError(
      "resource_scope_mismatch",
      "Session CAS capabilities must be issued to a Doc service",
    );
  }
}

function parseMode(value: string | undefined): CasInternalAuthMode {
  if (value === "legacy" || value === "dual" || value === "capability") return value;
  throw new TypeError("CAS internal auth mode must be explicit");
}

function parseJwks(value: string): CapabilityVerifierConfig["jwks"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("CAPABILITY_TRUSTED_JWKS must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { keys?: unknown }).keys)) {
    throw new TypeError("CAPABILITY_TRUSTED_JWKS must be a JWKS object");
  }
  return parsed as CapabilityVerifierConfig["jwks"];
}

function requireBinding(value: string | undefined, name: string): string {
  if (!value) throw new TypeError(`Missing CAS auth configuration: ${name}`);
  return value;
}