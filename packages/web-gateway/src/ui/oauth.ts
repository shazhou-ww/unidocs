/**
 * OAuth client for the UniDocs Gateway (RFC 7591 dynamic registration +
 * Authorization Code + PKCE S256, refresh rotation). Pure logic over fetch
 * and browser storage so the flows are unit-testable.
 *
 * The tenant is server-derived: authorize is called without a tenant_id and
 * the gateway resolves the authenticated Google account's default tenant
 * membership. After login the tenant comes from the access token's
 * `tenantId` claim.
 */

import { CLIENT_NAME, OAUTH_BASE, REDIRECT_URI } from "./config.js";
import { CREATION_TRACKING_KEY } from "./creation-tracking.js";
import { clearMarkdownDrafts } from "./markdown-draft.js";

const CLIENT_STORAGE_KEY = "unidocs.oauth.clientId";
const SESSION_STORAGE_KEY = "unidocs.oauth.session";
const PKCE_STORAGE_KEY = "unidocs.oauth.pkce";
const STATE_STORAGE_KEY = "unidocs.oauth.state";

export interface OAuthTokenSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number; // epoch seconds
  readonly scope: string;
  /** Server-derived tenant from the access token's tenantId claim. */
  readonly tenantId: string;
}

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

interface RegisteredClient {
  readonly clientId: string;
}

async function registerClient(redirectUri: string): Promise<RegisteredClient> {
  const response = await fetch(`${OAUTH_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      client_name: CLIENT_NAME,
    }),
  });
  if (!response.ok) {
    throw new OAuthError("registration_failed", `client registration failed with ${response.status}`);
  }
  const body = (await response.json()) as { client_id?: unknown };
  if (typeof body.client_id !== "string" || body.client_id.length === 0) {
    throw new OAuthError("registration_failed", "client registration returned no client_id");
  }
  return { clientId: body.client_id };
}

export async function ensureClientId(redirectUri: string = REDIRECT_URI): Promise<string> {
  const stored = localStorage.getItem(CLIENT_STORAGE_KEY);
  if (stored) return stored;
  const client = await registerClient(redirectUri);
  localStorage.setItem(CLIENT_STORAGE_KEY, client.clientId);
  return client.clientId;
}

/**
 * Redirects the browser to the gateway authorize endpoint. No tenant is
 * sent: the gateway derives it from the authenticated account's membership.
 */
export async function startLogin(options: { scope?: string; redirectUri?: string } = {}): Promise<void> {
  const redirectUri = options.redirectUri ?? REDIRECT_URI;
  const clientId = await ensureClientId(redirectUri);
  const verifier = generateVerifier();
  const challenge = await s256Challenge(verifier);
  const state = randomToken(16);
  sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify({ verifier, redirectUri }));
  sessionStorage.setItem(STATE_STORAGE_KEY, state);
  const url = new URL(`${OAUTH_BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", options.scope ?? "cas:read cas:write cas:manage");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.assign(url.toString());
}

/**
 * Completes the authorize redirect: exchanges the code for tokens and stores
 * the session. The tenant is read from the access token's `tenantId` claim.
 */
export async function completeLogin(url: URL): Promise<OAuthTokenSession> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new OAuthError("callback_invalid", "authorize callback is missing code or state");
  }
  const storedState = sessionStorage.getItem(STATE_STORAGE_KEY);
  sessionStorage.removeItem(STATE_STORAGE_KEY);
  if (!storedState || storedState !== state) {
    throw new OAuthError("callback_invalid", "authorize callback state does not match");
  }
  const pending = JSON.parse(sessionStorage.getItem(PKCE_STORAGE_KEY) ?? "null") as {
    verifier?: unknown;
    redirectUri?: unknown;
  } | null;
  sessionStorage.removeItem(PKCE_STORAGE_KEY);
  if (!pending || typeof pending.verifier !== "string" || typeof pending.redirectUri !== "string") {
    throw new OAuthError("callback_invalid", "authorize callback has no pending PKCE state");
  }
  return exchangeCode({ code, verifier: pending.verifier, redirectUri: pending.redirectUri });
}

export async function exchangeCode(options: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<OAuthTokenSession> {
  const clientId = await ensureClientId(options.redirectUri);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    client_id: clientId,
    redirect_uri: options.redirectUri,
    code_verifier: options.verifier,
  });
  const response = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new OAuthError("token_exchange_failed", "token exchange failed");
  }
  const session: OAuthTokenSession = {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : "",
    expiresAt: Math.floor(Date.now() / 1000) + Number(payload.expires_in ?? 120),
    scope: typeof payload.scope === "string" ? payload.scope : "",
    tenantId: tenantFromAccessToken(payload.access_token),
  };
  saveSession(session);
  return session;
}

export async function refreshSession(session: OAuthTokenSession): Promise<OAuthTokenSession> {
  if (!session.refreshToken) throw new OAuthError("no_refresh_token", "session has no refresh token");
  const clientId = await ensureClientId();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: clientId,
  });
  const response = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    if (response.status === 400 && payload.error === "invalid_grant") throw new OAuthError("invalid_grant", "登录已失效，请重新登录");
    throw new OAuthError("refresh_failed", "token refresh failed");
  }
  const next: OAuthTokenSession = {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : session.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + Number(payload.expires_in ?? 120),
    scope: typeof payload.scope === "string" ? payload.scope : session.scope,
    tenantId: tenantFromAccessToken(payload.access_token) || session.tenantId,
  };
  saveSession(next);
  return next;
}

export function loadSession(): OAuthTokenSession | null {
  const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OAuthTokenSession;
    if (typeof parsed.accessToken !== "string" || typeof parsed.expiresAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: OAuthTokenSession): void {
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): boolean {
  let cleared = true;
  for (const key of [SESSION_STORAGE_KEY, CREATION_TRACKING_KEY, PKCE_STORAGE_KEY, STATE_STORAGE_KEY]) {
    try { sessionStorage.removeItem(key); } catch { cleared = false; }
  }
  try { clearMarkdownDrafts(); } catch { cleared = false; }
  return cleared;
}

export function sessionIsExpired(session: OAuthTokenSession): boolean {
  return session.expiresAt - 30 < Math.floor(Date.now() / 1000);
}

/** Reads the tenantId claim from the access token payload (display/state only). */
function tenantFromAccessToken(accessToken: string): string {
  const segment = accessToken.split(".")[1];
  if (!segment) return "";
  try {
    const payload = JSON.parse(decodeBase64Url(segment)) as { tenantId?: unknown };
    return typeof payload.tenantId === "string" ? payload.tenantId : "";
  } catch {
    return "";
  }
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

const PKCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function generateVerifier(): string {
  const bytes = new Uint8Array(43);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += PKCE_ALPHABET[byte % PKCE_ALPHABET.length];
  return out;
}

export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function randomToken(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
