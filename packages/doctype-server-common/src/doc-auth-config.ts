import {
  CapabilityAlgorithm,
  CapabilityVerifier,
  parseCapabilityRuntimePolicy,
} from "@unidocs/service-auth";
import type {
  CapabilityRuntimePolicyBindings,
  CapabilityVerifierConfig,
} from "@unidocs/service-auth";
import type { DocCapabilityVerifier } from "./doc-type-handler.js";

export interface DocAuthBindings extends CapabilityRuntimePolicyBindings {
  readonly CAPABILITY_TRUSTED_JWKS?: string;
  readonly CAPABILITY_ISSUER?: string;
  readonly DOC_CAPABILITY_AUDIENCE?: string;
  readonly CAS_CAPABILITY_AUDIENCE?: string;
  /** Stack mode: the registered stack CAS issuer the delegated capability is signed by. */
  readonly CAS_STACK_ISSUER?: string;
  readonly CAS_STACK_TRUSTED_JWKS?: string;
}

export interface ResolvedDocAuthConfig {
  readonly docCapabilityVerifier: DocCapabilityVerifier;
  readonly casCapabilityVerifier: DocCapabilityVerifier;
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
  const issuer = requireBinding(bindings.CAPABILITY_ISSUER, "CAPABILITY_ISSUER");
  const policy = parseCapabilityRuntimePolicy(bindings);
  const docAudience = requireBinding(bindings.DOC_CAPABILITY_AUDIENCE, "DOC_CAPABILITY_AUDIENCE");
  const casAudience = requireBinding(bindings.CAS_CAPABILITY_AUDIENCE, "CAS_CAPABILITY_AUDIENCE");
  const jwks = parseJwks(
    requireBinding(bindings.CAPABILITY_TRUSTED_JWKS, "CAPABILITY_TRUSTED_JWKS"),
  );
  const casIssuer = requireBinding(bindings.CAS_STACK_ISSUER, "CAS_STACK_ISSUER");
  const casJwks = parseJwks(requireBinding(bindings.CAS_STACK_TRUSTED_JWKS, "CAS_STACK_TRUSTED_JWKS"));
  return Object.freeze({
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
      issuer: casIssuer,
      audience: casAudience,
      algorithm: CapabilityAlgorithm,
      jwks: casJwks,
      allowedPermissionKinds: ["cas:read", "cas:write"],
      allowedSubjects: [`doc:${docType}`],
      maximumLifetimeSeconds: policy.maximumLifetimeSeconds,
      clockSkewSeconds: policy.clockSkewSeconds,
    }),
  });
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