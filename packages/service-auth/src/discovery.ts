/**
 * RFC 8414 authorization-server discovery for capability verification.
 *
 * A document service that must not carry a manually copied key snapshot can
 * verify stack-issued capabilities against the issuer's discovered `jwks_uri`
 * instead: given the canonical issuer, derive the path-bearing well-known
 * metadata location, fetch it, exact-match the `issuer` field, and return the
 * validated `jwks_uri`. jose's remote key set then performs the live key
 * fetch with cooldown caching and unknown-`kid` refresh.
 *
 * All outbound discovery is hardened the same way the control plane's own
 * discovery is: HTTPS only, no credentials, no query/fragment on the issuer,
 * same-origin `jwks_uri`, bounded response size and time.
 */

export const OAuthDiscoveryTimeoutMs = 5_000;
export const OAuthDiscoveryMaxMetadataBytes = 64 * 1024;

export interface DiscoveredOAuthIssuerMetadata {
  readonly issuer: string;
  readonly jwksUri: string;
}

export function deriveOAuthIssuerMetadataUrl(issuer: string): URL {
  const url = requireCanonicalIssuer(issuer);
  const issuerPath = url.pathname === "/" ? "" : url.pathname;
  return new URL(`/.well-known/oauth-authorization-server${issuerPath}`, url.origin);
}

export async function discoverOAuthIssuerJwksUri(
  issuer: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const canonical = requireCanonicalIssuer(issuer).href.replace(/\/$/, "");
  const metadataUrl = deriveOAuthIssuerMetadataUrl(issuer);
  let response: Response;
  try {
    response = await fetcher(metadataUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OAuthDiscoveryTimeoutMs),
      redirect: "manual",
    });
  } catch (error) {
    throw new TypeError(
      `OAuth issuer discovery failed for ${issuer}: ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    throw new TypeError(
      `OAuth issuer discovery failed for ${issuer}: metadata responded ${response.status}`,
    );
  }
  const text = await boundedResponseText(response, OAuthDiscoveryMaxMetadataBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`OAuth issuer discovery failed for ${issuer}: metadata is not JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`OAuth issuer discovery failed for ${issuer}: metadata is not an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.issuer !== canonical) {
    throw new TypeError(
      `OAuth issuer discovery failed for ${issuer}: metadata issuer ${JSON.stringify(record.issuer)} does not match`,
    );
  }
  const jwksUri = record.jwks_uri;
  if (typeof jwksUri !== "string" || jwksUri.length === 0) {
    throw new TypeError(`OAuth issuer discovery failed for ${issuer}: metadata has no jwks_uri`);
  }
  let jwksUrl: URL;
  try {
    jwksUrl = new URL(jwksUri);
  } catch {
    throw new TypeError(`OAuth issuer discovery failed for ${issuer}: jwks_uri is not a URL`);
  }
  if (jwksUrl.protocol !== "https:" || jwksUrl.username || jwksUrl.password || jwksUrl.hash) {
    throw new TypeError(`OAuth issuer discovery failed for ${issuer}: jwks_uri must be a public HTTPS URL`);
  }
  if (jwksUrl.origin !== new URL(canonical).origin) {
    throw new TypeError(`OAuth issuer discovery failed for ${issuer}: jwks_uri uses a different origin`);
  }
  return jwksUrl.href;
}

export function isHttpsIssuerUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}

function requireCanonicalIssuer(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("OAuth issuer must be an absolute URL");
  }
  if (url.protocol !== "https:") throw new TypeError("OAuth issuer must use https");
  if (url.username || url.password) throw new TypeError("OAuth issuer must not contain credentials");
  if (!url.hostname) throw new TypeError("OAuth issuer must include a hostname");
  if (url.search || url.hash) throw new TypeError("OAuth issuer must not contain a query or fragment");
  return url;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new TypeError(`OAuth issuer discovery metadata exceeds the ${maxBytes}-byte limit`);
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new TypeError(`OAuth issuer discovery metadata exceeds the ${maxBytes}-byte limit`);
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
