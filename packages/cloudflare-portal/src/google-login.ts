import * as oauth from "oauth4webapi";
import { AdminAccessError, boundedBytes, googleIdentityFromConfirmedLogin, requireRecentAuthentication } from "@unidocs/portal-service";
import { hashSessionSecret } from "./auth.js";
import type { PortalGoogleConfig } from "./google-config.js";

export const LOGIN_COOKIE = "__Host-unidocs_admin_login";
const loginLifetime = 600;
const discoveryUrl = "https://accounts.google.com/.well-known/openid-configuration";
const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenUrl = "https://oauth2.googleapis.com/token";
const jwksUrl = "https://www.googleapis.com/oauth2/v3/certs";
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;

type GoogleLoginStage = "callback" | "browser_binding" | "state" | "discovery" | "authorization_response" | "token_exchange" | "token_response" | "signature" | "claims" | "identity" | "recent_authentication";
type GoogleLoginReason = "validation_failed" | "auth_time_missing" | "auth_time_invalid" | "authentication_too_old";

export class GoogleLoginError extends AdminAccessError {
  constructor(readonly stage: GoogleLoginStage, readonly reason: GoogleLoginReason = "validation_failed") {
    super("unauthorized");
    this.name = "GoogleLoginError";
  }
}

export interface PortalLoginTransaction {
  readonly stateHash: string;
  readonly browserHash: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly returnTo: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface PortalLoginPorts {
  readonly now: () => number;
  readonly put: (transaction: PortalLoginTransaction) => Promise<void>;
  readonly take: (stateHash: string, browserHash: string, now: number) => Promise<PortalLoginTransaction | null>;
  readonly fetch?: typeof fetch;
}

export function portalReturnPath(value: string): string {
  if (value.length > 2048 || !value.startsWith("/admin/") || /[\\\u0000-\u0020\u007f]/.test(value)) throw new AdminAccessError("unauthorized");
  const url = new URL(value, "https://portal.invalid");
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new AdminAccessError("unauthorized"); }
  if (url.origin !== "https://portal.invalid" || !pathname.startsWith("/admin/") || pathname === "/admin/auth" || pathname.startsWith("/admin/auth/") || /[%\\\u0000-\u0020\u007f]/.test(pathname) || pathname.split("/").some(segment => segment === "." || segment === "..")) throw new AdminAccessError("unauthorized");
  return url.pathname + url.search + url.hash;
}

function loginCookie(value: string, maxAge: number): string {
  return `${LOGIN_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function createPortalGoogleLogin(config: PortalGoogleConfig, ports: PortalLoginPorts) {
  if (config.issuer !== "https://accounts.google.com" || new URL(config.origin).origin !== config.origin || !config.origin.startsWith("https://") || config.redirectUri !== `${config.origin}/admin/auth/callback` || !config.clientId.trim() || !config.clientSecret.trim()) throw new TypeError("Invalid Portal Google configuration");

  const boundedFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (![discoveryUrl, tokenUrl, jwksUrl].includes(url)) throw new AdminAccessError("unauthorized");
    const timeout = AbortSignal.timeout(5000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await (ports.fetch ?? fetch)(input, { ...init, redirect: "manual", signal });
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel();
      throw new AdminAccessError("unauthorized");
    }
    if (!response.body) throw new AdminAccessError("unauthorized");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of boundedBytes(response.body, 65_536)) {
      signal.throwIfAborted();
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, { status: response.status, headers: response.headers });
  };

  const requestOptions = { [oauth.customFetch]: boundedFetch };

  async function metadata() {
    const issuer = new URL(config.issuer);
    const response = await oauth.discoveryRequest(issuer, requestOptions);
    const server = await oauth.processDiscoveryResponse(issuer, response);
    if (server.authorization_endpoint !== authorizationUrl || server.token_endpoint !== tokenUrl || server.jwks_uri !== jwksUrl || !server.code_challenge_methods_supported?.includes("S256")) throw new AdminAccessError("unauthorized");
    return server;
  }

  function currentTime(): number {
    const now = ports.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid login clock");
    return now;
  }

  return {
    async begin(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.origin !== config.origin || url.pathname !== "/admin/auth/login" || url.searchParams.getAll("returnTo").length > 1) throw new AdminAccessError("unauthorized");
      const returnTo = portalReturnPath(url.searchParams.get("returnTo") ?? "/admin/");
      const server = await metadata();
      const state = oauth.generateRandomState();
      const browser = oauth.generateRandomState();
      const nonce = oauth.generateRandomNonce();
      const verifier = oauth.generateRandomCodeVerifier();
      const now = currentTime();
      const target = new URL(server.authorization_endpoint!);
      target.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        nonce,
        code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      }).toString();
      await ports.put({ stateHash: await hashSessionSecret(state), browserHash: await hashSessionSecret(browser), verifier, nonce, returnTo, createdAt: now, expiresAt: now + loginLifetime });
      return new Response(null, { status: 303, headers: { Location: target.href, "Set-Cookie": loginCookie(browser, loginLifetime), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    },

    async complete(request: Request) {
      let stage: GoogleLoginStage = "callback";
      try {
        const url = new URL(request.url);
        if (request.method !== "GET" || url.origin !== config.origin || url.pathname !== "/admin/auth/callback" || url.hash) throw new AdminAccessError("unauthorized");
        const state = url.searchParams.get("state");
        if (!state || !opaquePattern.test(state) || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1 || url.search.length > 8192) throw new AdminAccessError("unauthorized");
        stage = "browser_binding";
        const cookies = (request.headers.get("cookie") ?? "").split(";").map(cookie => cookie.trim()).filter(cookie => cookie.split("=", 1)[0] === LOGIN_COOKIE);
        if (cookies.length !== 1) throw new AdminAccessError("unauthorized");
        const browser = cookies[0].slice(LOGIN_COOKIE.length + 1);
        if (!opaquePattern.test(browser)) throw new AdminAccessError("unauthorized");
        const now = currentTime();
        const stateHash = await hashSessionSecret(state);
        const browserHash = await hashSessionSecret(browser);
        stage = "state";
        const transaction = await ports.take(stateHash, browserHash, now);
        if (!transaction || transaction.stateHash !== stateHash || transaction.browserHash !== browserHash || !Number.isSafeInteger(transaction.createdAt) || !Number.isSafeInteger(transaction.expiresAt) || transaction.createdAt > now || transaction.expiresAt <= now || transaction.expiresAt <= transaction.createdAt || transaction.expiresAt - transaction.createdAt > loginLifetime || !opaquePattern.test(transaction.verifier) || !opaquePattern.test(transaction.nonce)) throw new AdminAccessError("unauthorized");
        const returnTo = portalReturnPath(transaction.returnTo);
        stage = "discovery";
        const server = await metadata();
        const client: oauth.Client = { client_id: config.clientId, id_token_signed_response_alg: "RS256", [oauth.clockSkew]: now - Math.floor(Date.now() / 1000), [oauth.clockTolerance]: 30 };
        stage = "authorization_response";
        const parameters = oauth.validateAuthResponse(server, client, url, state);
        stage = "token_exchange";
        const response = await oauth.authorizationCodeGrantRequest(server, client, oauth.ClientSecretPost(config.clientSecret), parameters, config.redirectUri, transaction.verifier, requestOptions);
        stage = "token_response";
        const result = await oauth.processAuthorizationCodeResponse(server, client, response, { expectedNonce: transaction.nonce, requireIdToken: true });
        stage = "signature";
        await oauth.validateApplicationLevelSignature(server, response, requestOptions);
        stage = "claims";
        const claims = oauth.getValidatedIdTokenClaims(result);
        if (!claims || !Number.isSafeInteger(claims.iat) || typeof claims.iat !== "number" || claims.iat < transaction.createdAt - 30 || claims.iat > now + 30 || (claims.azp !== undefined && claims.azp !== config.clientId)) throw new AdminAccessError("unauthorized");
        const completedAt = currentTime();
        if (completedAt < now || completedAt >= transaction.expiresAt || !Number.isSafeInteger(claims.exp) || typeof claims.exp !== "number" || completedAt >= claims.exp) throw new AdminAccessError("unauthorized");
        stage = "identity";
        if (claims.auth_time !== undefined && (typeof claims.auth_time !== "number" || !Number.isSafeInteger(claims.auth_time) || claims.auth_time < 0 || claims.auth_time > completedAt + 30)) throw new GoogleLoginError(stage, "auth_time_invalid");
        const identity = googleIdentityFromConfirmedLogin(claims, completedAt);
        stage = "recent_authentication";
        requireRecentAuthentication(identity, completedAt);
        return { identity, returnTo, clearLoginCookie: loginCookie("", 0) };
      } catch (error) {
        if (error instanceof GoogleLoginError) throw error;
        throw new GoogleLoginError(stage);
      }
    },
  };
}