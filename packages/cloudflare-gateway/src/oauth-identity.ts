import {
  OidcClient,
  generateOidcNonce,
  generatePkceVerifier,
  s256Challenge,
} from "@unicas/control-auth";
import type {
  GatewayOAuthAuthenticatedUser,
  GatewayOAuthIdentityPort,
} from "@unidocs/gateway-oauth";
import { decodeJwt } from "jose";
import type { AdminGoogleIdentity } from "@unidocs/gateway-common";

export interface GoogleLoginReplayStore {
  register(nonce: string, expiresAt: number): Promise<void>;
  consume(nonce: string, now: number): Promise<boolean>;
}

export interface VerifiedGoogleLogin extends AdminGoogleIdentity {
  readonly authenticatedAt: number;
  readonly expiresAt: number;
  readonly loginId: string;
}

export interface CloudflareGatewayOAuthIdentityBindings {
  /** Never configure outside local Miniflare/test environments. */
  readonly GATEWAY_OAUTH_LOCAL_IDENTITY?: string;
  readonly GATEWAY_OAUTH_LOCAL_PRINCIPAL?: string;
  readonly GATEWAY_OAUTH_LOCAL_DISPLAY_NAME?: string;

  // Production OIDC upstream mode (see createCloudflareGatewayOAuthIdentity).
  readonly GATEWAY_OIDC_CLIENT_ID?: string;
  readonly GATEWAY_OIDC_CLIENT_SECRET?: string;
  readonly GATEWAY_OIDC_ISSUER?: string;
  readonly GATEWAY_PUBLIC_ORIGIN?: string;
  readonly GATEWAY_OIDC_REDIRECT_PATH?: string;
  /** Base64 32-byte key sealing the gateway session cookie. */
  readonly GATEWAY_SESSION_ENCRYPTION_KEY?: string;
  readonly GATEWAY_OIDC_SESSION_TTL_SECONDS?: string;
}

export interface CloudflareGatewayOAuthIdentityPorts {
  readonly identity: GatewayOAuthIdentityPort;
  readonly currentGoogleLogin: (request: Request) => Promise<VerifiedGoogleLogin | null>;
  readonly managementAuthenticationRequired: (request: Request) => Response;
  /** Handles the OIDC login start and callback routes; null means unrelated. */
  readonly handleLogin: (request: Request) => Promise<Response | null>;
  /** Redirects unauthenticated authorize requests to the login start. */
  readonly authenticationRequired: (request: Request) => Response;
}

const failClosedIdentity: GatewayOAuthIdentityPort = Object.freeze({
  async currentUser(): Promise<null> {
    return null;
  },
});

/** No OAuth issuer configured: no login routes, every authorize request 401s. */
export function createFailClosedGatewayOAuthIdentity(): CloudflareGatewayOAuthIdentityPorts {
  return Object.freeze({
    identity: failClosedIdentity,
    currentGoogleLogin: async () => null,
    managementAuthenticationRequired: () => Response.json({ error: "login_required" }, { status: 401 }),
    handleLogin: async () => null,
    authenticationRequired: () =>
      Response.json({ error: "login_required" }, { status: 401 }),
  });
}

const SESSION_COOKIE = "gw_sess";
const LOGIN_COOKIE = "gw_login_binding";
const DEFAULT_OIDC_ISSUER = "https://accounts.google.com";
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_CONTINUE_URL_LENGTH = 4096;

/**
 * Gateway OAuth user identity.
 *
 * - Production (`GATEWAY_OIDC_CLIENT_ID` set): upstream OIDC authorization
 *   code + PKCE (Google by default) with an encrypted session cookie. The
 *   gateway remains the Stack OAuth authorization server; this adapter only
 *   authenticates the browser user for its consent flow.
 * - Local (`GATEWAY_OAUTH_LOCAL_IDENTITY=unsafe-development-only`): a fixed
 *   principal, accepted only on loopback / reserved `.test` hosts.
 * - Otherwise: fail closed.
 */
export function createCloudflareGatewayOAuthIdentity(
  bindings: CloudflareGatewayOAuthIdentityBindings,
  issuer: string,
  replayStore?: GoogleLoginReplayStore,
): CloudflareGatewayOAuthIdentityPorts {
  if (bindings.GATEWAY_OIDC_CLIENT_ID !== undefined) {
    return createOidcIdentity(bindings, issuer, replayStore);
  }
  const local = createLocalIdentity(bindings);
  return {
    identity: local,
    currentGoogleLogin: async () => null,
    managementAuthenticationRequired: () => Response.json({ error: "login_required" }, { status: 401 }),
    handleLogin: async () => null,
    authenticationRequired: () =>
      Response.json({ error: "login_required" }, { status: 401 }),
  };
}

function createLocalIdentity(
  bindings: CloudflareGatewayOAuthIdentityBindings,
): GatewayOAuthIdentityPort {
  if (bindings.GATEWAY_OAUTH_LOCAL_IDENTITY === undefined) return failClosedIdentity;
  if (bindings.GATEWAY_OAUTH_LOCAL_IDENTITY !== "unsafe-development-only") {
    throw new Error("GATEWAY_OAUTH_LOCAL_IDENTITY has an invalid value");
  }
  const principalId = bindings.GATEWAY_OAUTH_LOCAL_PRINCIPAL?.trim();
  if (!principalId) throw new Error("GATEWAY_OAUTH_LOCAL_PRINCIPAL is required in local identity mode");
  const user = Object.freeze({
    principalId,
    displayName: bindings.GATEWAY_OAUTH_LOCAL_DISPLAY_NAME?.trim() || null,
  }) satisfies GatewayOAuthAuthenticatedUser;
  return Object.freeze({
    async currentUser(request: Request): Promise<GatewayOAuthAuthenticatedUser | null> {
      return isDevelopmentHost(new URL(request.url).hostname) ? user : null;
    },
  });
}

function createOidcIdentity(
  bindings: CloudflareGatewayOAuthIdentityBindings,
  issuer: string,
  replayStore?: GoogleLoginReplayStore,
): CloudflareGatewayOAuthIdentityPorts {
  const clientId = requireConfigured(bindings.GATEWAY_OIDC_CLIENT_ID, "GATEWAY_OIDC_CLIENT_ID");
  const clientSecret = bindings.GATEWAY_OIDC_CLIENT_SECRET ?? "";
  const oidcIssuer = (bindings.GATEWAY_OIDC_ISSUER ?? DEFAULT_OIDC_ISSUER).replace(/\/$/, "");
  const publicOrigin = requireConfigured(bindings.GATEWAY_PUBLIC_ORIGIN, "GATEWAY_PUBLIC_ORIGIN");
  const sessionKey = requireConfigured(
    bindings.GATEWAY_SESSION_ENCRYPTION_KEY,
    "GATEWAY_SESSION_ENCRYPTION_KEY",
  );
  const issuerUrl = new URL(issuer);
  const basePath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
  const callbackPath = bindings.GATEWAY_OIDC_REDIRECT_PATH
    ?? `${basePath}/login/callback`;
  const loginPath = callbackPath.replace(/\/callback$/, "");
  if (!callbackPath.startsWith("/") || !loginPath.startsWith("/")) {
    throw new Error("GATEWAY_OIDC_REDIRECT_PATH must be an absolute path");
  }
  const redirectUri = `${publicOrigin.replace(/\/$/, "")}${callbackPath}`;
  const sessionTtlSeconds = parseSessionTtl(bindings.GATEWAY_OIDC_SESSION_TTL_SECONDS);
  const oidc = new OidcClient({
    issuer: oidcIssuer,
    clientId,
    clientSecret,
    redirectUri,
  });
  const sealer = createCookieSealer(sessionKey);

  const identity: GatewayOAuthIdentityPort = Object.freeze({
    async currentUser(request: Request): Promise<GatewayOAuthAuthenticatedUser | null> {
      const session = await openSession(request, sealer);
      return session === null ? null : Object.freeze({
        principalId: session.sub,
        displayName: session.name,
        ...(session.email === undefined ? {} : { email: session.email }),
      });
    },
  });

  const authenticationRequired = (request: Request): Response => {
    // Never leak a login redirect to a different origin than the public one:
    // rebuild the continue URL onto the public origin, keeping path + query.
    const source = new URL(request.url);
    const origin = publicOrigin.replace(/\/$/, "");
    const continueUrl = source.origin === origin
      ? source
      : new URL(source.pathname + source.search, origin);
    const target = new URL(loginPath, origin);
    target.searchParams.set("continue", continueUrl.toString());
    return new Response(null, {
      status: 303,
      headers: {
        Location: target.toString(),
        "Cache-Control": "no-store",
      },
    });
  };

  const managementAuthenticationRequired = (request: Request): Response => {
    const response = authenticationRequired(request);
    const target = new URL(response.headers.get("Location")!);
    target.searchParams.set("reauth", "1");
    response.headers.set("Location", target.toString());
    return response;
  };

  const currentGoogleLogin = async (request: Request): Promise<VerifiedGoogleLogin | null> => {
    if (!replayStore || oidcIssuer !== DEFAULT_OIDC_ISSUER || new URL(request.url).origin !== new URL(publicOrigin).origin) return null;
    const session = await openSession(request, sealer);
    if (!session || session.iss !== DEFAULT_OIDC_ISSUER || session.emailVerified !== true || !session.email
      || session.replayProtected !== true || typeof session.loginId !== "string" || !session.loginId
      || session.loginConfirmation !== "authorization-code-v1"
      || !Number.isSafeInteger(session.authenticatedAt) || session.authenticatedAt! <= 0 || session.authenticatedAt! > Date.now()) return null;
    return {
      issuer: session.iss, subject: session.sub, email: session.email, emailVerified: true,
      authenticatedAt: session.authenticatedAt!, expiresAt: session.exp * 1000, loginId: session.loginId
    };
  };

  const handleLogin = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      return url.pathname === loginPath || url.pathname === callbackPath
        ? new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } })
        : null;
    }

    if (url.pathname === loginPath) {
      if (url.origin !== new URL(publicOrigin).origin) return new Response("Invalid login origin", { status: 400 });
      const continueUrl = url.searchParams.get("continue") ?? publicOrigin;
      if (continueUrl.length > MAX_CONTINUE_URL_LENGTH || !isSameOrigin(continueUrl, publicOrigin)) {
        return new Response("Invalid continue URL", { status: 400 });
      }
      const verifier = generatePkceVerifier();
      const browserBinding = generateOidcNonce();
      const state = {
        nonce: generateOidcNonce(),
        verifier,
        continue: continueUrl,
        exp: Date.now() + OIDC_STATE_TTL_MS,
        browserBinding,
        replayProtected: Boolean(replayStore),
        reauth: url.searchParams.get("reauth") === "1",
      };
      if (state.reauth && !replayStore) return new Response("Management login unavailable", { status: 503 });
      const challenge = await s256Challenge(verifier);
      const sealedState = await sealer.seal(JSON.stringify(state));
      const authorizationUrl = new URL(await oidc.authorizationUrl({
        state: sealedState,
        nonce: state.nonce,
        codeChallenge: challenge,
      }));
      await replayStore?.register(state.nonce, state.exp);
      return new Response(null, {
        status: 303,
        headers: {
          Location: authorizationUrl.toString(),
          "Cache-Control": "no-store",
          "Set-Cookie": cookie(LOGIN_COOKIE, browserBinding, { httpOnly: true, secure: isSecureOrigin(publicOrigin), sameSite: "Lax", maxAge: OIDC_STATE_TTL_MS / 1000 }),
        },
      });
    }

    if (url.pathname === callbackPath) {
      if (url.origin !== new URL(publicOrigin).origin) return new Response("Invalid login origin", { status: 400 });
      const code = url.searchParams.get("code");
      const stateValue = url.searchParams.get("state");
      if (!code || !stateValue) {
        return new Response("Missing OIDC callback parameters", { status: 400 });
      }
      const stateText = await sealer.open(stateValue).catch(() => null);
      if (stateText === null) {
        return new Response("Invalid OIDC state", { status: 400 });
      }
      let state: OidcLoginState;
      try {
        state = JSON.parse(stateText) as OidcLoginState;
      } catch {
        return new Response("Invalid OIDC state", { status: 400 });
      }
      if (typeof state.nonce !== "string" || typeof state.verifier !== "string"
        || typeof state.continue !== "string" || typeof state.exp !== "number"
        || !Number.isFinite(state.exp) || state.exp <= Date.now()
        || !isSameOrigin(state.continue, publicOrigin)
        || typeof state.browserBinding !== "string" || !state.browserBinding
        || state.browserBinding !== readCookie(request, LOGIN_COOKIE)) {
        return new Response("Invalid OIDC state", { status: 400 });
      }
      if (state.replayProtected && (!replayStore || !await replayStore.consume(state.nonce, Date.now()))) return new Response("OIDC state already consumed or expired", { status: 400 });
      if (state.reauth && state.replayProtected !== true) return new Response("Invalid management login", { status: 400 });
      const exchanged = await oidc.exchangeCode({ code, codeVerifier: state.verifier });
      const verified = await oidc.verifyIdToken({
        idToken: exchanged.idToken,
        nonce: state.nonce,
      });
      const claims = decodeJwt(exchanged.idToken);
      const confirmedAt = Date.now();
      const issuedAt = typeof claims.iat === "number" && Number.isSafeInteger(claims.iat) ? claims.iat * 1000 : null;
      const tokenExpiresAt = typeof claims.exp === "number" && Number.isSafeInteger(claims.exp) ? claims.exp * 1000 : null;
      const freshCodeExchange = issuedAt !== null && tokenExpiresAt !== null && tokenExpiresAt > confirmedAt
        && issuedAt <= confirmedAt + 30_000 && issuedAt >= state.exp - OIDC_STATE_TTL_MS - 30_000;
      if (state.reauth && !freshCodeExchange) {
        return new Response("Google login confirmation failed. Please start a new login from /admin/.", { status: 403, headers: { "Cache-Control": "no-store" } });
      }
      console.log(JSON.stringify({
        event: "gateway_oauth_login",
        principalId: verified.sub,
        issuer: oidcIssuer,
      }));
      const session = {
        sub: verified.sub,
        iss: oidcIssuer,
        emailVerified: verified.emailVerified,
        authenticatedAt: state.replayProtected === true && freshCodeExchange ? confirmedAt : null,
        loginConfirmation: state.replayProtected === true && freshCodeExchange ? "authorization-code-v1" : null,
        loginId: state.nonce,
        replayProtected: state.replayProtected === true,
        name: verified.name ?? verified.email ?? verified.sub,
        ...(verified.email === null ? {} : { email: verified.email }),
        exp: Math.floor(Date.now() / 1000) + sessionTtlSeconds,
      };
      const target = new URL(state.continue);
      return new Response(null, {
        status: 303,
        headers: {
          Location: target.toString(),
          "Cache-Control": "no-store",
          "Set-Cookie": cookie(SESSION_COOKIE, await sealer.seal(JSON.stringify(session)), {
            httpOnly: true,
            secure: isSecureOrigin(publicOrigin),
            sameSite: "Lax",
            maxAge: sessionTtlSeconds,
          }),
        },
      });
    }

    return null;
  };

  return { identity, handleLogin, authenticationRequired, currentGoogleLogin, managementAuthenticationRequired };
}

interface OidcLoginState {
  readonly nonce: string;
  readonly verifier: string;
  readonly continue: string;
  readonly exp: number;
  readonly browserBinding: string;
  readonly replayProtected?: boolean;
  readonly reauth?: boolean;
}

interface GatewaySession {
  readonly sub: string;
  readonly name: string;
  readonly email?: string;
  readonly exp: number;
  readonly iss?: string;
  readonly emailVerified?: boolean;
  readonly authenticatedAt?: number | null;
  readonly loginConfirmation?: "authorization-code-v1" | null;
  readonly loginId?: string;
  readonly replayProtected?: boolean;
}

interface CookieSealer {
  seal(value: string): Promise<string>;
  open(value: string): Promise<string>;
}

/** AES-256-GCM seal over a SHA-256-derived key from the session key secret. */
function createCookieSealer(sessionKey: string): CookieSealer {
  const material = new TextEncoder().encode(sessionKey);
  return {
    async seal(value: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await sealKey(material);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(value),
      );
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return base64Url(combined);
    },
    async open(value: string): Promise<string> {
      const combined = base64UrlDecode(value);
      if (combined.byteLength < 12 + 16) throw new Error("sealed value is too short");
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const key = await sealKey(material);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      return new TextDecoder().decode(plaintext);
    },
  };
}

async function sealKey(material: Uint8Array): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function openSession(
  request: Request,
  sealer: CookieSealer,
): Promise<GatewaySession | null> {
  const value = readCookie(request, SESSION_COOKIE);
  if (value === null) return null;
  const text = await sealer.open(value).catch(() => null);
  if (text === null) return null;
  let session: GatewaySession;
  try {
    session = JSON.parse(text) as GatewaySession;
  } catch {
    return null;
  }
  if (typeof session.sub !== "string" || session.sub.length === 0
    || typeof session.exp !== "number" || !Number.isFinite(session.exp) || session.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return session;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    if (trimmed.slice(0, separator) === name) {
      return trimmed.slice(separator + 1);
    }
  }
  return null;
}

function cookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; secure: boolean; sameSite: "Lax" | "Strict"; maxAge: number },
): string {
  const parts = [`${name}=${value}`, "Path=/"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite}`);
  parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  return parts.join("; ");
}

function parseSessionTtl(value: string | undefined): number {
  const seconds = value === undefined ? DEFAULT_SESSION_TTL_SECONDS : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 300 || seconds > 90 * 24 * 60 * 60) {
    throw new Error("GATEWAY_OIDC_SESSION_TTL_SECONDS must be an integer from 300 to 7776000");
  }
  return seconds;
}

function requireConfigured(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Gateway OAuth identity configuration: ${name}`);
  return value;
}

function isSameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function isSecureOrigin(origin: string): boolean {
  return origin.startsWith("https://");
}

function isDevelopmentHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname.endsWith(".test");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
