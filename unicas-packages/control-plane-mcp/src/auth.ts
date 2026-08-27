import type {
  AuthorizationError,
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
  generateOidcNonce,
  generatePkceVerifier,
  OidcClient,
  s256Challenge,
} from "@unicas/control-auth";
import { CONTROL_PLANE_MCP_SCOPES, emailAllowed } from "./config.js";
import type { ControlPlaneMcpGrantProps } from "./server.js";

const AUTH_COOKIE = "unicas_mcp_oauth";
const CONSENT_COOKIE = "unicas_mcp_consent";
const TRANSACTION_TTL_SECONDS = 10 * 60;

export interface OAuthAuthorizationEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  PUBLIC_ORIGIN?: string;
  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  OAUTH_STATE_ENCRYPTION_KEY?: string;
  OIDC_ISSUER?: string;
  OIDC_DISCOVERY_URL?: string;
  ADMIN_EMAIL_ALLOWLIST?: string;
}

interface PendingGoogleAuthorization {
  readonly kind: "google";
  readonly oauthRequest: AuthRequest;
  readonly oidcNonce: string;
  readonly oidcCodeVerifier: string;
}

interface PendingConsent {
  readonly kind: "consent";
  readonly oauthRequest: AuthRequest;
  readonly identity: {
    readonly identityIssuer: string;
    readonly subject: string;
    readonly displayName: string | null;
    readonly emailForDisplay: string | null;
  };
  readonly clientName: string;
  readonly csrfToken: string;
}

type PendingAuthorization = PendingGoogleAuthorization | PendingConsent;

export interface OAuthAuthorizationHandlerOptions {
  readonly oidcFactory?: (env: OAuthAuthorizationEnv) => OidcClient;
}

export function createOAuthAuthorizationHandler(options: OAuthAuthorizationHandlerOptions = {}) {
  return {
    async fetch(request: Request, env: OAuthAuthorizationEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/authorize" && request.method === "GET") {
        return startAuthorization(request, env, options);
      }
      if (url.pathname === "/oauth/google/callback" && request.method === "GET") {
        return finishGoogleAuthentication(request, env, options);
      }
      if (url.pathname === "/oauth/authorize" && request.method === "POST") {
        return finishConsent(request, env);
      }
      return new Response("Not Found", { status: 404 });
    },
  };
}

async function startAuthorization(
  request: Request,
  env: OAuthAuthorizationEnv,
  options: OAuthAuthorizationHandlerOptions,
): Promise<Response> {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await oauthProvider(env).parseAuthRequest(request);
  } catch (error) {
    return authorizationError(error);
  }
  const unsupportedScopes = oauthRequest.scope.filter(
    (scope) => !CONTROL_PLANE_MCP_SCOPES.includes(scope as (typeof CONTROL_PLANE_MCP_SCOPES)[number]),
  );
  if (unsupportedScopes.length > 0) {
    return oauthErrorRedirect(oauthRequest, "invalid_scope", "The request contains an unsupported scope");
  }
  const transactionId = randomToken();
  const oidcNonce = generateOidcNonce();
  const oidcCodeVerifier = generatePkceVerifier();
  await writeTransaction(env, transactionId, {
    kind: "google",
    oauthRequest,
    oidcNonce,
    oidcCodeVerifier,
  });
  const location = await oidcClient(env, options).authorizationUrl({
    state: transactionId,
    nonce: oidcNonce,
    codeChallenge: await s256Challenge(oidcCodeVerifier),
  });
  return redirectWithCookie(location, AUTH_COOKIE, transactionId);
}

async function finishGoogleAuthentication(
  request: Request,
  env: OAuthAuthorizationEnv,
  options: OAuthAuthorizationHandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const transactionId = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!transactionId || !code || readCookie(request, AUTH_COOKIE) !== transactionId) {
    return authFailure("Invalid or expired Google authorization state");
  }
  const transaction = await takeTransaction(env, transactionId);
  if (!transaction || transaction.kind !== "google") {
    return authFailure("Invalid or expired Google authorization state");
  }
  try {
    const oidc = oidcClient(env, options);
    const exchanged = await oidc.exchangeCode({ code, codeVerifier: transaction.oidcCodeVerifier });
    const identity = await oidc.verifyIdToken({
      idToken: exchanged.idToken,
      nonce: transaction.oidcNonce,
    });
    if (!identity.emailVerified || !emailAllowed(identity.email, env.ADMIN_EMAIL_ALLOWLIST)) {
      return authFailure("This Google account is not allowed to access the Unicas control plane", 403);
    }
    const client = await oauthProvider(env).lookupClient(transaction.oauthRequest.clientId);
    if (!client) return authFailure("OAuth client is no longer registered");
    const consentId = randomToken();
    const csrfToken = randomToken();
    const pending: PendingConsent = {
      kind: "consent",
      oauthRequest: transaction.oauthRequest,
      identity: {
        identityIssuer: env.OIDC_ISSUER ?? "https://accounts.google.com",
        subject: identity.sub,
        displayName: identity.name,
        emailForDisplay: identity.email,
      },
      clientName: client.clientName ?? "MCP client",
      csrfToken,
    };
    await writeTransaction(env, consentId, pending);
    return htmlWithCookie(renderConsent(pending, consentId), CONSENT_COOKIE, consentId);
  } catch {
    return authFailure("Google authentication could not be completed");
  }
}

async function finishConsent(request: Request, env: OAuthAuthorizationEnv): Promise<Response> {
  const publicOrigin = requireEnv(env.PUBLIC_ORIGIN, "PUBLIC_ORIGIN");
  if (request.headers.get("Origin") !== publicOrigin) {
    return authFailure("Consent must be submitted from the authorization server origin", 403);
  }
  const form = await request.formData().catch(() => null);
  const consentId = form?.get("consent_id");
  const csrfToken = form?.get("csrf_token");
  const decision = form?.get("decision");
  if (
    typeof consentId !== "string"
    || readCookie(request, CONSENT_COOKIE) !== consentId
    || typeof csrfToken !== "string"
  ) {
    return authFailure("Invalid or expired consent transaction");
  }
  const pending = await takeTransaction(env, consentId);
  if (!pending || pending.kind !== "consent" || !(await secureEqual(csrfToken, pending.csrfToken))) {
    return authFailure("Invalid or expired consent transaction");
  }
  if (decision !== "approve") {
    return oauthDeniedRedirect(pending.oauthRequest);
  }
  const grantedScopes = pending.oauthRequest.scope.filter(
    (scope): scope is (typeof CONTROL_PLANE_MCP_SCOPES)[number] =>
      CONTROL_PLANE_MCP_SCOPES.includes(scope as (typeof CONTROL_PLANE_MCP_SCOPES)[number]),
  );
  const oauthClientId = pending.oauthRequest.clientId;
  const oauthClientHandle = await sha256Hex(oauthClientId);
  const props: ControlPlaneMcpGrantProps = {
    ...pending.identity,
    scopes: grantedScopes,
    oauthClientId,
    oauthClientHandle,
  };
  const { redirectTo } = await oauthProvider(env).completeAuthorization({
    request: pending.oauthRequest,
    userId: await identityHandle(pending.identity.identityIssuer, pending.identity.subject),
    metadata: {
      clientHandle: oauthClientHandle,
      clientName: pending.clientName,
    },
    scope: grantedScopes,
    props,
  });
  return clearCookieRedirect(redirectTo, CONSENT_COOKIE);
}

function oidcClient(env: OAuthAuthorizationEnv, options: OAuthAuthorizationHandlerOptions): OidcClient {
  if (options.oidcFactory) return options.oidcFactory(env);
  const clientId = requireEnv(env.GOOGLE_OIDC_CLIENT_ID, "GOOGLE_OIDC_CLIENT_ID");
  const clientSecret = requireEnv(env.GOOGLE_OIDC_CLIENT_SECRET, "GOOGLE_OIDC_CLIENT_SECRET");
  const publicOrigin = requireEnv(env.PUBLIC_ORIGIN, "PUBLIC_ORIGIN");
  return new OidcClient({
    issuer: env.OIDC_ISSUER ?? "https://accounts.google.com",
    discoveryUrl: env.OIDC_DISCOVERY_URL,
    clientId,
    clientSecret,
    redirectUri: `${publicOrigin}/oauth/google/callback`,
  });
}

async function writeTransaction(
  env: OAuthAuthorizationEnv,
  id: string,
  value: PendingAuthorization,
): Promise<void> {
  const encrypted = await encryptJson(value, requireEnv(env.OAUTH_STATE_ENCRYPTION_KEY, "OAUTH_STATE_ENCRYPTION_KEY"));
  await env.OAUTH_KV.put(transactionKey(id), encrypted, { expirationTtl: TRANSACTION_TTL_SECONDS });
}

async function takeTransaction(env: OAuthAuthorizationEnv, id: string): Promise<PendingAuthorization | null> {
  const key = transactionKey(id);
  const encrypted = await env.OAUTH_KV.get(key);
  if (!encrypted) return null;
  await env.OAUTH_KV.delete(key);
  try {
    return await decryptJson(encrypted, requireEnv(env.OAUTH_STATE_ENCRYPTION_KEY, "OAUTH_STATE_ENCRYPTION_KEY"));
  } catch {
    return null;
  }
}

function transactionKey(id: string): string {
  return `unicas:oauth-transaction:${id}`;
}

async function encryptJson(value: PendingAuthorization, encodedKey: string): Promise<string> {
  const key = await importAesKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return `${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

async function decryptJson(value: string, encodedKey: string): Promise<PendingAuthorization> {
  const [ivPart, ciphertextPart] = value.split(".");
  if (!ivPart || !ciphertextPart) throw new Error("invalid encrypted transaction");
  const key = await importAesKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(ivPart) },
    key,
    base64UrlDecode(ciphertextPart),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as PendingAuthorization;
}

async function importAesKey(value: string): Promise<CryptoKey> {
  const bytes = base64UrlDecode(value);
  if (bytes.byteLength !== 32) throw new Error("OAUTH_STATE_ENCRYPTION_KEY must encode 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function renderConsent(pending: PendingConsent, consentId: string): string {
  const scopes = pending.oauthRequest.scope
    .map((scope) => {
      const detail = scopeDetail(scope);
      return `<li class="scope-row${detail.sensitive ? " scope-row-sensitive" : ""}">
        <span class="scope-icon" aria-hidden="true">${detail.icon}</span>
        <span class="scope-copy"><strong>${escapeHtml(detail.title)}</strong><span>${escapeHtml(detail.description)}</span></span>
        <code>${escapeHtml(scope)}</code>
      </li>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Authorize ${escapeHtml(pending.clientName)} · UniCAS</title>
  <style>
    :root { color-scheme: light; font-family: "Aptos", "Segoe UI Variable Text", "Segoe UI", sans-serif; color: #18181b; background: #f8f8f9; font-synthesis: none; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; background-color: #f8f8f9; background-image: linear-gradient(rgba(24,24,27,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(24,24,27,.022) 1px,transparent 1px); background-size: 28px 28px; font-size: 14px; line-height: 1.5; letter-spacing: 0; }
    .topbar { display: flex; height: 52px; align-items: center; padding: 0 20px; background: rgba(255,255,255,.94); border-bottom: 1px solid #e1e1e4; }
    .brand { display: inline-flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 650; }
    .brand-mark { display: grid; width: 26px; height: 26px; place-items: center; color: #fafafa; background: #27272a; border-radius: 6px; font-size: 12px; font-weight: 750; }
    main { display: grid; min-height: calc(100vh - 52px); place-items: center; padding: 32px 16px 12vh; }
    .panel { width: min(480px,100%); padding: 24px; background: #fff; border: 1px solid #e1e1e4; border-radius: 7px; box-shadow: 0 8px 30px rgba(24,24,27,.06); animation: enter 180ms ease-out both; }
    .eyebrow { margin: 0 0 6px; color: #71717a; font-size: 12px; font-weight: 650; text-transform: uppercase; }
    h1 { margin: 0; font-size: 23px; line-height: 1.25; }
    .intro { margin: 9px 0 20px; color: #52525b; }
    .identity { display: flex; align-items: center; gap: 10px; padding: 11px 0 18px; border-bottom: 1px solid #e1e1e4; }
    .avatar { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; color: #3f3f46; background: #f4f4f5; border: 1px solid #e1e1e4; border-radius: 50%; font-weight: 700; }
    .identity-copy { min-width: 0; }
    .identity-copy span { display: block; color: #71717a; font-size: 12px; }
    .identity-copy strong { display: block; overflow-wrap: anywhere; font-weight: 600; }
    .section-title { margin: 18px 0 7px; font-size: 13px; font-weight: 650; }
    .resource { margin: 0 0 8px; color: #71717a; font-size: 12px; overflow-wrap: anywhere; }
    .scope-list { margin: 0; padding: 0; list-style: none; border-top: 1px solid #e1e1e4; }
    .scope-row { display: grid; grid-template-columns: 30px minmax(0,1fr) auto; gap: 10px; align-items: center; padding: 13px 0; border-bottom: 1px solid #e1e1e4; }
    .scope-icon { display: grid; width: 28px; height: 28px; place-items: center; color: #52525b; background: #f4f4f5; border: 1px solid #e1e1e4; border-radius: 6px; font-weight: 750; }
    .scope-row-sensitive .scope-icon { color: #b42318; background: #fff1f0; border-color: #ffd5d2; }
    .scope-copy strong, .scope-copy span { display: block; }
    .scope-copy strong { font-size: 13px; font-weight: 650; }
    .scope-copy span { margin-top: 1px; color: #71717a; font-size: 12px; }
    code { padding: 3px 6px; color: #52525b; background: #f4f4f5; border-radius: 4px; font: 11px/1.35 "Cascadia Code","SFMono-Regular",Consolas,monospace; white-space: nowrap; }
    form { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 20px; }
    button { min-height: 40px; padding: 0 15px; border: 1px solid #c9c9ce; border-radius: 6px; font: inherit; font-weight: 650; cursor: pointer; }
    .deny { color: #27272a; background: #fff; }
    .deny:hover { background: #f4f4f5; }
    .approve { color: #fafafa; background: #27272a; border-color: #27272a; }
    .approve:hover { background: #09090b; }
    button:focus-visible { outline: 2px solid #52525b; outline-offset: 2px; }
    .footnote { margin: 14px 0 0; color: #71717a; font-size: 11px; text-align: center; }
    @keyframes enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 520px) { main { place-items: start center; padding-top: 22px; } .panel { padding: 20px; } .scope-row { grid-template-columns: 30px minmax(0,1fr); } code { grid-column: 2; justify-self: start; } }
  </style>
</head>
<body>
  <header class="topbar"><span class="brand"><span class="brand-mark">U</span>UniCAS</span></header>
  <main>
    <section class="panel" aria-labelledby="consent-title">
      <p class="eyebrow">Authorization request</p>
      <h1 id="consent-title">Allow ${escapeHtml(pending.clientName)}?</h1>
      <p class="intro">This application is requesting access to your UniCAS control plane.</p>
      <div class="identity">
        <span class="avatar" aria-hidden="true">${escapeHtml(identityInitial(pending))}</span>
        <span class="identity-copy"><span>Signed in as</span><strong>${escapeHtml(pending.identity.emailForDisplay ?? pending.identity.subject)}</strong></span>
      </div>
      <p class="section-title">Requested permissions</p>
      <p class="resource">${escapeHtml(String(pending.oauthRequest.resource ?? "UniCAS control plane"))}</p>
      <ul class="scope-list">${scopes}</ul>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
        <input type="hidden" name="csrf_token" value="${escapeHtml(pending.csrfToken)}">
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
      </form>
      <p class="footnote">You can revoke this access at any time.</p>
    </section>
  </main>
</body>
</html>`;
}

function scopeDetail(scope: string): {
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly sensitive: boolean;
} {
  switch (scope) {
    case "control:read":
      return { title: "View control-plane data", description: "Read stacks, members, issuer configuration, and audit records.", icon: "R", sensitive: false };
    case "control:write":
      return { title: "Manage stack configuration", description: "Create stacks and update non-security settings.", icon: "W", sensitive: false };
    case "control:security":
      return { title: "Manage security settings", description: "Invite or remove members and rotate issuer keys.", icon: "!", sensitive: true };
    default:
      return { title: scope, description: "Access requested by this application.", icon: "·", sensitive: false };
  }
}

function identityInitial(pending: PendingConsent): string {
  const identity = pending.identity.emailForDisplay ?? pending.identity.displayName ?? pending.identity.subject;
  return identity.trim().charAt(0).toUpperCase() || "U";
}

function authorizationError(error: unknown): Response {
  if (!isAuthorizationError(error)) return authFailure("OAuth authorization request failed");
  if (!error.redirectUri) return authFailure(error.description, 400);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

function oauthDeniedRedirect(request: AuthRequest): Response {
  return oauthErrorRedirect(request, "access_denied");
}

function oauthErrorRedirect(request: AuthRequest, code: string, description?: string): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  if (description) redirect.searchParams.set("error_description", description);
  redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return clearCookieRedirect(redirect.toString(), CONSENT_COOKIE);
}

function authFailure(message: string, status = 400): Response {
  return Response.json({ error: "AUTHORIZATION_FAILED", message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function redirectWithCookie(location: string, name: string, value: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Set-Cookie": cookieHeader(name, value),
      "Cache-Control": "no-store",
    },
  });
}

function htmlWithCookie(html: string, name: string, value: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": cookieHeader(name, value),
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function clearCookieRedirect(location: string, name: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Set-Cookie": `${name}=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      "Cache-Control": "no-store",
    },
  });
}

function cookieHeader(name: string, value: string): string {
  return `${name}=${value}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=${TRANSACTION_TTL_SECONDS}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const item of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return null;
}

function randomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

async function identityHandle(issuer: string, subject: string): Promise<string> {
  return sha256Hex(`${issuer}\0${subject}`);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  let difference = leftHash.length ^ rightHash.length;
  for (let index = 0; index < Math.min(leftHash.length, rightHash.length); index += 1) {
    difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

function oauthProvider(env: OAuthAuthorizationEnv): OAuthHelpers {
  if (!env.OAUTH_PROVIDER) throw new Error("OAUTH_PROVIDER is unavailable");
  return env.OAUTH_PROVIDER;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isAuthorizationError(error: unknown): error is AuthorizationError {
  if (!(error instanceof Error) || error.name !== "AuthorizationError") return false;
  const candidate = error as Error & Record<string, unknown>;
  const codes = new Set([
    "invalid_request",
    "invalid_target",
    "unauthorized_client",
    "access_denied",
    "unsupported_response_type",
    "invalid_scope",
    "server_error",
    "temporarily_unavailable",
  ]);
  return typeof candidate.code === "string"
    && codes.has(candidate.code)
    && typeof candidate.description === "string"
    && (candidate.redirectUri === undefined || typeof candidate.redirectUri === "string")
    && (candidate.state === undefined || typeof candidate.state === "string")
    && (candidate.issuer === undefined || typeof candidate.issuer === "string");
}