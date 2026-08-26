import {
  CapabilityAlgorithm,
  CapabilityVerifier,
  parseCapabilityRuntimePolicy,
} from "@unidocs/service-auth";
import type {
  CapabilityRuntimePolicyBindings,
  CapabilityVerifierConfig,
} from "@unidocs/service-auth";
import type { DocCapabilityVerifier, DocInternalAuthMode } from "./doc-type-handler.js";

export interface DocAuthBindings extends CapabilityRuntimePolicyBindings {
  readonly INTERNAL_AUTH_MODE?: string;
  readonly SERVICE_ACCESS_KEY?: string;
  readonly CAPABILITY_TRUSTED_JWKS?: string;
  readonly CAPABILITY_ISSUER?: string;
  readonly DOC_CAPABILITY_AUDIENCE?: string;
  readonly CAS_CAPABILITY_AUDIENCE?: string;
}

export interface ResolvedDocAuthConfig {
  readonly internalAuthMode: DocInternalAuthMode;
  readonly accessKey?: string;
  readonly docCapabilityVerifier?: DocCapabilityVerifier;
  readonly casCapabilityVerifier?: DocCapabilityVerifier;
}

export class DocAuthConfigCache {
  readonly #docType: string;
  #resolved: ResolvedDocAuthConfig | undefined;

  constructor(docType: string) {
    if (docType.length === 0) throw new TypeError("Configured Doc type is required");
    this.#docType = docType;
  }

  get(bindings: DocAuthBindings): ResolvedDocAuthConfig {
    this.#resolved ??= resolveDocAuthConfig(this.#docType, bindings);
    return this.#resolved;
  }
}

export function resolveDocAuthConfig(
  docType: string,
  bindings: DocAuthBindings,
): ResolvedDocAuthConfig {
  const internalAuthMode = parseDocInternalAuthMode(bindings.INTERNAL_AUTH_MODE);
  const usesLegacy = internalAuthMode === "legacy" || internalAuthMode === "dual";
  const usesCapability = internalAuthMode === "capability" || internalAuthMode === "dual";
  const accessKey = usesLegacy
    ? requireBinding(bindings.SERVICE_ACCESS_KEY, "SERVICE_ACCESS_KEY")
    : undefined;
  if (!usesCapability) return Object.freeze({ internalAuthMode, accessKey });

  const issuer = requireBinding(bindings.CAPABILITY_ISSUER, "CAPABILITY_ISSUER");
  const policy = parseCapabilityRuntimePolicy(bindings);
  const docAudience = requireBinding(bindings.DOC_CAPABILITY_AUDIENCE, "DOC_CAPABILITY_AUDIENCE");
  const casAudience = requireBinding(bindings.CAS_CAPABILITY_AUDIENCE, "CAS_CAPABILITY_AUDIENCE");
  const jwks = parseJwks(
    requireBinding(bindings.CAPABILITY_TRUSTED_JWKS, "CAPABILITY_TRUSTED_JWKS"),
  );
  return Object.freeze({
    internalAuthMode,
    ...(accessKey === undefined ? {} : { accessKey }),
    docCapabilityVerifier: new CapabilityVerifier({
      issuer,
      audience: docAudience,
      algorithm: CapabilityAlgorithm,
      jwks,
      allowedPermissionKinds: ["sessions:create", "sessions:read", "sessions:write"],
      allowedSubjects: ["gateway"],
      maximumLifetimeSeconds: policy.maximumLifetimeSeconds,
      clockSkewSeconds: policy.clockSkewSeconds,
    }),
    casCapabilityVerifier: new CapabilityVerifier({
      issuer,
      audience: casAudience,
      algorithm: CapabilityAlgorithm,
      jwks,
      allowedPermissionKinds: ["cas:read", "cas:write"],
      allowedSubjects: [`doc:${docType}`],
      maximumLifetimeSeconds: policy.maximumLifetimeSeconds,
      clockSkewSeconds: policy.clockSkewSeconds,
    }),
  });
}

function parseDocInternalAuthMode(value: string | undefined): DocInternalAuthMode {
  if (value === "legacy" || value === "dual" || value === "capability") return value;
  throw new TypeError("Doc internal auth mode must be explicit");
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
  if (!value) throw new TypeError(`Missing Doc auth configuration: ${name}`);
  return value;
}