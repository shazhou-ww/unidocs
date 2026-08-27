/**
 * Google OIDC authorization-code client (PKCE + nonce + state).
 *
 * Discovery/JWKS are fetched from the configured issuer and cached; a
 * token-supplied JWKS location is never trusted. Only the configured issuer,
 * audience (client id), and RS256 are accepted. The client is pure: all I/O
 * goes through an injectable `fetchImpl` so tests can substitute a mock
 * provider.
 */

import { createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet } from "jose";

export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

export interface VerifiedOidcIdentity {
  readonly sub: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
}

export interface OidcClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly discoveryTtlMs?: number;
  readonly jwksTtlMs?: number;
}

export class OidcClient {
  readonly #issuer: string;
  readonly #discoveryUrl: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #discoveryTtlMs: number;
  readonly #jwksTtlMs: number;
  #discovery: { fetchedAt: number; value: OidcDiscovery } | null = null;
  #jwks: { fetchedAt: number; value: JSONWebKeySet } | null = null;

  constructor(
    config: {
      readonly issuer: string;
      readonly discoveryUrl?: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly redirectUri: string;
    },
    options: OidcClientOptions = {},
  ) {
    this.#issuer = config.issuer;
    this.#discoveryUrl = config.discoveryUrl
      ?? `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
    this.#redirectUri = config.redirectUri;
    // Bind fetch: calling the global fetch detached from its receiver throws
    // "Illegal invocation" in workerd.
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#fetch = (input, init) => fetchImpl(input, init);
    this.#now = options.now ?? (() => Date.now());
    this.#discoveryTtlMs = options.discoveryTtlMs ?? 60 * 60 * 1000;
    this.#jwksTtlMs = options.jwksTtlMs ?? 60 * 60 * 1000;
  }

  async discovery(): Promise<OidcDiscovery> {
    const now = this.#now();
    if (this.#discovery && now - this.#discovery.fetchedAt < this.#discoveryTtlMs) {
      return this.#discovery.value;
    }
    const response = await this.#fetch(this.#discoveryUrl, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new OidcError("discovery_failed", `OIDC discovery failed with ${response.status}`);
    }
    const doc = (await response.json()) as Record<string, unknown>;
    const value: OidcDiscovery = {
      issuer: requireString(doc, "issuer"),
      authorization_endpoint: requireString(doc, "authorization_endpoint"),
      token_endpoint: requireString(doc, "token_endpoint"),
      jwks_uri: requireString(doc, "jwks_uri"),
    };
    if (value.issuer !== this.#issuer) {
      throw new OidcError("discovery_failed", "OIDC discovery issuer does not match the configured issuer");
    }
    this.#discovery = { fetchedAt: now, value };
    return value;
  }

  async authorizationUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
  }): Promise<string> {
    const doc = await this.discovery();
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("redirect_uri", this.#redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<{ readonly idToken: string; readonly accessToken: string | null }> {
    const doc = await this.discovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.#redirectUri,
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      code_verifier: input.codeVerifier,
    });
    const response = await this.#fetch(doc.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new OidcError("token_exchange_failed", `OIDC token exchange failed with ${response.status}`);
    }
    const idToken = payload.id_token;
    if (typeof idToken !== "string" || idToken.length === 0) {
      throw new OidcError("token_exchange_failed", "OIDC token exchange returned no id_token");
    }
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
    // Refresh tokens are not retained in the MVP (config flag off).
    return { idToken, accessToken };
  }

  async verifyIdToken(input: {
    readonly idToken: string;
    readonly nonce: string;
  }): Promise<VerifiedOidcIdentity> {
    const doc = await this.discovery();
    const jwks = await this.#loadJwks(doc.jwks_uri);
    const keySet = createLocalJWKSet(jwks);
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      const result = await jwtVerify(input.idToken, keySet, {
        algorithms: ["RS256"],
        issuer: this.#issuer,
        audience: this.#clientId,
        clockTolerance: 30,
      });
      payload = result.payload;
    } catch {
      throw new OidcError("id_token_invalid", "OIDC id_token verification failed");
    }
    if (payload.nonce !== input.nonce) {
      throw new OidcError("id_token_invalid", "OIDC id_token nonce mismatch");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new OidcError("id_token_invalid", "OIDC id_token has no subject");
    }
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" && payload.email.length > 0 ? payload.email : null,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" && payload.name.length > 0 ? payload.name : null,
    };
  }

  async #loadJwks(jwksUri: string): Promise<JSONWebKeySet> {
    const now = this.#now();
    if (this.#jwks && now - this.#jwks.fetchedAt < this.#jwksTtlMs) {
      return this.#jwks.value;
    }
    const response = await this.#fetch(jwksUri, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new OidcError("jwks_failed", `OIDC JWKS fetch failed with ${response.status}`);
    }
    const value = (await response.json()) as JSONWebKeySet;
    if (!Array.isArray(value.keys) || value.keys.length === 0) {
      throw new OidcError("jwks_failed", "OIDC JWKS contains no keys");
    }
    this.#jwks = { fetchedAt: now, value };
    return value;
  }
}

export class OidcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OidcError";
    this.code = code;
  }
}

function requireString(doc: Record<string, unknown>, name: string): string {
  const value = doc[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new OidcError("discovery_failed", `OIDC discovery is missing '${name}'`);
  }
  return value;
}

// ----------------------------------------------------------------------
// PKCE helpers
// ----------------------------------------------------------------------

const PKCE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function generatePkceVerifier(): string {
  const bytes = new Uint8Array(43);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += PKCE_ALPHABET[byte % PKCE_ALPHABET.length];
  }
  return out;
}

export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function generateOidcState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function generateOidcNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
