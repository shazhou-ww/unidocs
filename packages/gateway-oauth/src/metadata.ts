import { GatewayOAuthScopes, type GatewayOAuthScope } from "./scopes.js";

export interface GatewayOAuthServerMetadataConfig {
  readonly issuer: string;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly jwksUri?: string;
  readonly registrationEndpoint?: string | null;
  readonly revocationEndpoint?: string | null;
  readonly scopesSupported?: readonly GatewayOAuthScope[];
}

export interface GatewayOAuthAuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly registration_endpoint?: string;
  readonly revocation_endpoint?: string;
  readonly response_types_supported: readonly ["code"];
  readonly grant_types_supported: readonly ["authorization_code", "refresh_token"];
  readonly code_challenge_methods_supported: readonly ["S256"];
  readonly token_endpoint_auth_methods_supported: readonly ["none"];
  readonly scopes_supported: readonly GatewayOAuthScope[];
}

/** Validate while preserving the issuer identifier for exact JWT/discovery matching. */
export function canonicalizeGatewayOAuthIssuer(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError("OAuth issuer must be an absolute URL");
  }
  if (url.protocol !== "https:") throw new TypeError("OAuth issuer must use https");
  if (url.username || url.password) throw new TypeError("OAuth issuer must not contain credentials");
  if (!url.hostname) throw new TypeError("OAuth issuer must include a hostname");
  if (url.search || url.hash) throw new TypeError("OAuth issuer must not contain a query or fragment");
  return trimmed;
}

/** RFC 8414 well-known location for a possibly path-bearing issuer. */
export function gatewayOAuthMetadataPath(issuer: string): string {
  const url = new URL(canonicalizeGatewayOAuthIssuer(issuer));
  const issuerPath = url.pathname === "/" ? "" : url.pathname;
  return `/.well-known/oauth-authorization-server${issuerPath}`;
}

/** OIDC compatibility location derived by appending to the issuer identifier. */
export function gatewayOpenIdConfigurationPath(issuer: string): string {
  const url = new URL(canonicalizeGatewayOAuthIssuer(issuer));
  return `${url.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`;
}

export function renderGatewayOAuthMetadata(
  config: GatewayOAuthServerMetadataConfig,
): GatewayOAuthAuthorizationServerMetadata {
  const issuer = canonicalizeGatewayOAuthIssuer(config.issuer);
  const base = issuer.replace(/\/$/, "");
  const scopes = config.scopesSupported ?? GatewayOAuthScopes;
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) {
    throw new TypeError("OAuth scopes must be non-empty and unique");
  }
  const metadata: GatewayOAuthAuthorizationServerMetadata = {
    issuer,
    authorization_endpoint: requireIssuerEndpoint(config.authorizationEndpoint ?? `${base}/authorize`, issuer, "authorization endpoint"),
    token_endpoint: requireIssuerEndpoint(config.tokenEndpoint ?? `${base}/token`, issuer, "token endpoint"),
    jwks_uri: requireIssuerEndpoint(config.jwksUri ?? `${base}/jwks`, issuer, "JWKS URI"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: Object.freeze([...scopes]),
    ...(config.registrationEndpoint
      ? { registration_endpoint: requireIssuerEndpoint(config.registrationEndpoint, issuer, "registration endpoint") }
      : {}),
    ...(config.revocationEndpoint
      ? { revocation_endpoint: requireIssuerEndpoint(config.revocationEndpoint, issuer, "revocation endpoint") }
      : {}),
  };
  return Object.freeze(metadata);
}

function requireIssuerEndpoint(value: string, issuer: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError(`${label} must be a public HTTPS URL without credentials or fragment`);
  }
  if (url.origin !== new URL(issuer).origin) {
    throw new TypeError(`${label} must use the issuer origin`);
  }
  return value;
}
