export type OAuthMetadataType = "oauth" | "oidc";

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
