import { validatePublicJwk } from "./control-possession.js";
import { isSupportedKeyAlgorithm, type SupportedKeyAlgorithm } from "./control-validation.js";

export type OAuthMetadataType = "oauth" | "oidc";

export const OAUTH_DISCOVERY_MAX_KEYS = 20;
export const OAUTH_ISSUER_INSPECTION_CHALLENGE_VERSION = "cas-oauth-issuer-inspection-v1";
export const OAUTH_ISSUER_INSPECTION_TTL_MS = 10 * 60 * 1000;

export interface OAuthDiscoveryCandidate {
  readonly type: OAuthMetadataType;
  readonly url: string;
}

export interface DiscoveredOAuthMetadata {
  readonly issuer: string;
  readonly metadataUrl: string;
  readonly metadataType: OAuthMetadataType;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly registrationEndpoint: string | null;
  readonly scopesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
}

export interface DiscoveredOAuthJwk {
  readonly kid: string;
  readonly algorithm: SupportedKeyAlgorithm;
  readonly publicJwk: Readonly<Record<string, unknown>>;
}

export interface OAuthDiscoveryResult {
  readonly metadata: DiscoveredOAuthMetadata;
  readonly metadataDigest: string;
  readonly jwksDigest: string;
  readonly keys: readonly DiscoveredOAuthJwk[];
}

/** Platform-owned network boundary. Implementations must apply SSRF controls. */
export interface OAuthDiscoveryPort {
  inspectIssuer(input: { readonly issuer: string }): Promise<OAuthDiscoveryResult>;
}

export interface OAuthIssuerInspectionChallengeInput {
  readonly nonce: string;
  readonly inspectionId: string;
  readonly stackId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly metadataDigest: string;
  readonly jwksDigest: string;
  readonly capabilityMaxLifetimeSeconds: number;
  readonly expiresAt: number;
}

export function buildOAuthIssuerInspectionChallenge(
  input: OAuthIssuerInspectionChallengeInput,
): string {
  return [
    OAUTH_ISSUER_INSPECTION_CHALLENGE_VERSION,
    input.nonce,
    input.inspectionId,
    input.stackId,
    input.issuer,
    input.audience,
    input.metadataDigest,
    input.jwksDigest,
    String(input.capabilityMaxLifetimeSeconds),
    String(input.expiresAt),
  ].join("\n");
}

export function parseOAuthIssuerInspectionChallenge(
  challenge: string,
): OAuthIssuerInspectionChallengeInput | null {
  const parts = challenge.split("\n");
  if (parts.length !== 10 || parts[0] !== OAUTH_ISSUER_INSPECTION_CHALLENGE_VERSION) return null;
  const [, nonce, inspectionId, stackId, issuer, audience, metadataDigest, jwksDigest, lifetimeText, expiresText] = parts;
  const capabilityMaxLifetimeSeconds = Number(lifetimeText);
  const expiresAt = Number(expiresText);
  if (!nonce || !inspectionId || !stackId || !issuer || !audience || !metadataDigest || !jwksDigest
    || !Number.isSafeInteger(capabilityMaxLifetimeSeconds) || !Number.isSafeInteger(expiresAt)) return null;
  return {
    nonce,
    inspectionId,
    stackId,
    issuer,
    audience,
    metadataDigest,
    jwksDigest,
    capabilityMaxLifetimeSeconds,
    expiresAt,
  };
}

/** Validate an issuer while preserving its identifier for exact metadata/token matching. */
export function canonicalizeOAuthIssuer(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError("issuer must be an absolute URL");
  }
  if (url.protocol !== "https:") throw new TypeError("issuer must use https");
  if (url.username || url.password) throw new TypeError("issuer must not contain credentials");
  if (!url.hostname) throw new TypeError("issuer must include a hostname");
  if (url.search || url.hash) throw new TypeError("issuer must not contain a query or fragment");

  return trimmed;
}

/** Standard metadata locations for a canonical, possibly path-bearing issuer. */
export function oauthDiscoveryCandidates(issuer: string): readonly OAuthDiscoveryCandidate[] {
  const canonical = canonicalizeOAuthIssuer(issuer);
  const url = new URL(canonical);
  const issuerPath = url.pathname === "/" ? "" : url.pathname;
  const oidcUrl = `${canonical.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const oauthUrl = `${url.origin}/.well-known/oauth-authorization-server${issuerPath}`;
  return [
    { type: "oauth", url: oauthUrl },
    { type: "oidc", url: oidcUrl },
  ];
}

/** Validate an untrusted metadata document before it can enter control state. */
export function parseOAuthMetadata(
  input: unknown,
  expectedIssuer: string,
  candidate: OAuthDiscoveryCandidate,
): DiscoveredOAuthMetadata {
  if (!isRecord(input)) throw new TypeError("OAuth metadata must be a JSON object");
  const canonicalIssuer = canonicalizeOAuthIssuer(expectedIssuer);
  if (input.issuer !== canonicalIssuer) {
    throw new TypeError("metadata issuer must exactly match the registered issuer");
  }

  const authorizationEndpoint = requireHttpsEndpoint(input.authorization_endpoint, "authorization_endpoint");
  const tokenEndpoint = requireHttpsEndpoint(input.token_endpoint, "token_endpoint");
  const jwksUri = requireHttpsEndpoint(input.jwks_uri, "jwks_uri");
  const registrationEndpoint = input.registration_endpoint === undefined
    ? null
    : requireHttpsEndpoint(input.registration_endpoint, "registration_endpoint");
  const scopesSupported = optionalStringArray(input.scopes_supported, "scopes_supported");
  const codeChallengeMethodsSupported = optionalStringArray(
    input.code_challenge_methods_supported,
    "code_challenge_methods_supported",
  );
  if (!codeChallengeMethodsSupported.includes("S256")) {
    throw new TypeError("authorization server must advertise PKCE S256 support");
  }

  return {
    issuer: canonicalIssuer,
    metadataUrl: candidate.url,
    metadataType: candidate.type,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    registrationEndpoint,
    scopesSupported,
    codeChallengeMethodsSupported,
  };
}

/** Validate a provider JWKS before persisting a trusted snapshot. */
export function parseOAuthJwks(input: unknown): readonly DiscoveredOAuthJwk[] {
  if (!isRecord(input) || !Array.isArray(input.keys)) {
    throw new TypeError("JWKS must be a JSON object containing a keys array");
  }
  if (input.keys.length === 0) throw new TypeError("JWKS must contain at least one key");
  if (input.keys.length > OAUTH_DISCOVERY_MAX_KEYS) {
    throw new TypeError(`JWKS must contain at most ${OAUTH_DISCOVERY_MAX_KEYS} keys`);
  }

  const seen = new Set<string>();
  return input.keys.map((value, index) => {
    if (!isRecord(value)) throw new TypeError(`JWKS key ${index} must be an object`);
    if (typeof value.kid !== "string" || value.kid.length === 0 || value.kid.length > 128) {
      throw new TypeError(`JWKS key ${index} must have a non-empty kid of at most 128 characters`);
    }
    if (seen.has(value.kid)) throw new TypeError(`JWKS contains duplicate kid '${value.kid}'`);
    seen.add(value.kid);
    if (typeof value.alg !== "string" || !isSupportedKeyAlgorithm(value.alg)) {
      throw new TypeError(`JWKS key '${value.kid}' uses an unsupported algorithm`);
    }
    if (value.use !== undefined && value.use !== "sig") {
      throw new TypeError(`JWKS key '${value.kid}' is not a signing key`);
    }
    if (value.key_ops !== undefined) {
      if (!Array.isArray(value.key_ops)
        || value.key_ops.some((operation) => operation !== "verify")
        || !value.key_ops.includes("verify")) {
        throw new TypeError(`JWKS key '${value.kid}' has invalid key_ops`);
      }
    }
    if ("jku" in value || "x5u" in value) {
      throw new TypeError(`JWKS key '${value.kid}' must not contain remote key URLs`);
    }
    const validationError = validatePublicJwk(value, value.alg);
    if (validationError) throw new TypeError(`JWKS key '${value.kid}': ${validationError}`);
    return { kid: value.kid, algorithm: value.alg, publicJwk: { ...value } };
  });
}

function requireHttpsEndpoint(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} is required`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new TypeError(`${field} must be an HTTPS URL without credentials`);
  }
  if (url.hash) throw new TypeError(`${field} must not contain a fragment`);
  return url.toString();
}

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
