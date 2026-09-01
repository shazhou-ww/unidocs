import {
  CapabilityAlgorithm,
  CapabilityVerifier,
  discoverOAuthIssuerJwksUri,
  parseCapabilityRuntimePolicy,
} from "@unidocs/service-auth";
import type {
  CapabilityRuntimePolicyBindings,
  CapabilityVerifierConfig,
} from "@unidocs/service-auth";
import type { DocCapabilityVerifier } from "./doc-type-handler.js";

export interface DocAuthBindings extends CapabilityRuntimePolicyBindings {
  /**
   * Doc-service identity: the Gateway signs session capabilities with this
   * issuer, and its public keys are provisioned here as a pinned snapshot
   * (`CAPABILITY_TRUSTED_JWKS`). There is no published `jwks_uri` for this
   * identity, so discovery does not apply.
   */
  readonly CAPABILITY_TRUSTED_JWKS?: string;
  readonly CAPABILITY_ISSUER?: string;
  readonly DOC_CAPABILITY_AUDIENCE?: string;
  readonly CAS_CAPABILITY_AUDIENCE?: string;
  /** Stack mode: the registered stack CAS issuer the delegated capability is signed by. */
  readonly CAS_STACK_ISSUER?: string;
  /**
   * Stack issuer public keys, obtained one of three ways:
   *
   * - `CAS_STACK_JWKS_URI` set to a URL — verify against that `jwks_uri`
   *   (jose remote key set with cooldown caching and unknown-`kid` refresh);
   * - `CAS_STACK_JWKS_URI` set to `"discover"` — derive the RFC 8414
   *   metadata URL from `CAS_STACK_ISSUER` and use its `jwks_uri`;
   * - unset — the pinned `CAS_STACK_TRUSTED_JWKS` snapshot.
   */
  readonly CAS_STACK_JWKS_URI?: string;
  /** Pinned snapshot of the stack issuer's public keys (non-discovery mode). */
  readonly CAS_STACK_TRUSTED_JWKS?: string;
}

export interface ResolvedDocAuthConfig {
  readonly docCapabilityVerifier: DocCapabilityVerifier;
  readonly casCapabilityVerifier: DocCapabilityVerifier;
}

export class DocAuthConfigCache {
  readonly #docType: string;
  #resolved: Promise<ResolvedDocAuthConfig> | undefined;

  constructor(docType: string) {
    if (docType.length === 0) throw new TypeError("Configured Doc type is required");
    this.#docType = docType;
  }

  get(bindings: DocAuthBindings): Promise<ResolvedDocAuthConfig> {
    this.#resolved ??= resolveDocAuthConfig(this.#docType, bindings);
    return this.#resolved;
  }
}

export async function resolveDocAuthConfig(
  docType: string,
  bindings: DocAuthBindings,
): Promise<ResolvedDocAuthConfig> {
  const issuer = requireBinding(bindings.CAPABILITY_ISSUER, "CAPABILITY_ISSUER");
  const policy = parseCapabilityRuntimePolicy(bindings);
  const docAudience = requireBinding(bindings.DOC_CAPABILITY_AUDIENCE, "DOC_CAPABILITY_AUDIENCE");
  const casAudience = requireBinding(bindings.CAS_CAPABILITY_AUDIENCE, "CAS_CAPABILITY_AUDIENCE");
  const jwks = parseJwks(
    requireBinding(bindings.CAPABILITY_TRUSTED_JWKS, "CAPABILITY_TRUSTED_JWKS"),
  );
  const casIssuer = requireBinding(bindings.CAS_STACK_ISSUER, "CAS_STACK_ISSUER");
  const casJwks = await resolveCasJwks(bindings, casIssuer);
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

async function resolveCasJwks(
  bindings: DocAuthBindings,
  casIssuer: string,
): Promise<CapabilityVerifierConfig["jwks"]> {
  const jwksUri = bindings.CAS_STACK_JWKS_URI?.trim();
  if (jwksUri === "discover") {
    return new URL(await discoverOAuthIssuerJwksUri(casIssuer));
  }
  if (jwksUri) {
    return new URL(jwksUri);
  }
  return parseJwks(
    requireBinding(bindings.CAS_STACK_TRUSTED_JWKS, "CAS_STACK_TRUSTED_JWKS"),
  );
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
