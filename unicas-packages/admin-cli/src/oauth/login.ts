/**
 * Interactive `unicas login`: the CLI performs its own Google OIDC
 * authorization-code flow (S256 PKCE) with a local `127.0.0.1` callback
 * server, then exchanges the verified id_token with the `/admin` BFF for a
 * session cookie + CSRF token. The session is persisted for later commands.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OidcClient,
  OidcError,
  generateOidcNonce,
  generateOidcState,
  generatePkceVerifier,
  s256Challenge,
} from "@unicas/control-auth";
import type { VerifiedOidcIdentity } from "@unicas/control-auth";
import type { PersistedSession, TokenStore } from "../store.js";
import { DEFAULT_GOOGLE_ISSUER } from "../config.js";

export interface LoginFlowOptions {
  /** Origin of the `/admin` API. */
  readonly adminOrigin: string;
  /** Google OAuth client id registered for this CLI. */
  readonly googleClientId: string;
  readonly googleClientSecret?: string;
  readonly googleIssuer?: string;
  readonly store: TokenStore;
  /** Explicit loopback port; `0` (default) picks a free ephemeral port. */
  readonly port?: number;
  /** Open the system browser automatically (default true). */
  readonly openBrowser?: boolean;
  /** Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Abort signal; rejects the pending callback with an error. */
  readonly signal?: AbortSignal;
  /** Log line sink (defaults to stderr). */
  readonly log?: (message: string) => void;
  /** Test hook: invoked with the loopback port once the callback server listens. */
  readonly onCallbackServerStarted?: (port: number) => void;
  /** Test hook: invoked with the authorization URL right before the browser opens. */
  readonly onAuthorizeUrl?: (url: URL) => void;
}

export interface LoginFlowResult {
  readonly session: PersistedSession;
  readonly authorizationUrl: string;
  readonly identity: VerifiedOidcIdentity;
}

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

export async function runLoginFlow(options: LoginFlowOptions): Promise<LoginFlowResult> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const callback = new LocalCallbackServer(options.signal);
  await callback.start(options.port ?? 0);
  options.onCallbackServerStarted?.(callback.port);
  const redirectUrl = `http://127.0.0.1:${callback.port}/callback`;

  const oidc = new OidcClient(
    {
      issuer: options.googleIssuer ?? DEFAULT_GOOGLE_ISSUER,
      clientId: options.googleClientId,
      clientSecret: options.googleClientSecret ?? "",
      redirectUri: redirectUrl,
    },
    { fetchImpl },
  );

  const state = generateOidcState();
  const nonce = generateOidcNonce();
  const codeVerifier = generatePkceVerifier();
  const codeChallenge = await s256Challenge(codeVerifier);
  let authorizeUrl: string;
  try {
    authorizeUrl = await oidc.authorizationUrl({ state, nonce, codeChallenge });
  } catch (error) {
    throw networkError("Google OIDC discovery", options.googleIssuer ?? DEFAULT_GOOGLE_ISSUER, error);
  }
  callback.captureState(state);
  options.onAuthorizeUrl?.(new URL(authorizeUrl));
  log("");
  log("Open this URL in your browser to authorize the Unicas CLI:");
  log(`  ${authorizeUrl}`);
  log("");
  if (options.openBrowser !== false) {
    await openBrowser(authorizeUrl).catch(() => {
      log("Could not open a browser automatically; copy the URL above.");
    });
  }

  const code = await callback.waitForCode();
  await callback.close();

  let exchanged: Awaited<ReturnType<typeof oidc.exchangeCode>>;
  try {
    exchanged = await oidc.exchangeCode({ code, codeVerifier });
  } catch (error) {
    // Retry once on transport-level failures: a connect failure happens before
    // any bytes are sent, so retrying the same code is safe. A code already
    // consumed server-side surfaces as invalid_grant (an HTTP response), which
    // is not retried here.
    if (error instanceof OidcError && error.code === "network_failed") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      exchanged = await oidc.exchangeCode({ code, codeVerifier });
    } else {
      throw networkError("Google token exchange", options.googleIssuer ?? DEFAULT_GOOGLE_ISSUER, error);
    }
  }
  const identity = await oidc.verifyIdToken({ idToken: exchanged.idToken, nonce });

  const session = await exchangeForSession(options, exchanged.idToken, nonce, identity);
  await options.store.save(session);
  return { session, authorizationUrl: callback.authorizationUrl, identity };
}

async function exchangeForSession(
  options: LoginFlowOptions,
  idToken: string,
  nonce: string,
  identity: VerifiedOidcIdentity,
): Promise<PersistedSession> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.adminOrigin}/admin/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, nonce }),
    });
  } catch (error) {
    throw networkError("/admin/auth/exchange", options.adminOrigin, error);
  }
  if (!response.ok) {
    throw new Error(`admin session exchange failed with HTTP ${response.status}`);
  }
  const setCookie = response.headers.get("Set-Cookie");
  const body = await response.json() as { csrfToken?: unknown };
  if (setCookie === null || typeof body.csrfToken !== "string" || body.csrfToken.length === 0) {
    throw new Error("admin session exchange returned no session");
  }
  return {
    adminOrigin: options.adminOrigin,
    cookie: setCookie.split(";")[0]!,
    csrfToken: body.csrfToken,
    identity: {
      identityIssuer: options.googleIssuer ?? DEFAULT_GOOGLE_ISSUER,
      subject: identity.sub,
      displayName: identity.name,
      emailForDisplay: identity.email,
    },
    savedAt: Date.now(),
  };
}

class LocalCallbackServer {
  readonly #signal: AbortSignal | undefined;
  readonly #server = createServer((request, response) => this.#handle(request.url ?? "/", response));
  #port = 0;
  #state: string | undefined;
  #authorizeUrl = "";
  #waiters: Waiter[] = [];

  constructor(signal: AbortSignal | undefined) {
    this.#signal = signal;
  }

  get port(): number {
    return this.#port;
  }

  get authorizationUrl(): string {
    return this.#authorizeUrl;
  }

  start(requestedPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(requestedPort, "127.0.0.1", () => {
        this.#server.removeListener("error", reject);
        this.#port = (this.#server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  captureState(state: string | undefined): void {
    this.#state = state;
  }

  captureAuthorizeUrl(url: string): void {
    this.#authorizeUrl = url;
  }

  waitForCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      waiter.timeout = setTimeout(() => {
        this.#settle(waiter, undefined, new Error("Timed out waiting for the browser authorization callback"));
      }, CALLBACK_TIMEOUT_MS);
      this.#waiters.push(waiter);
      if (this.#signal) {
        const onAbort = () => this.#settle(waiter, undefined, new Error("login aborted"));
        if (this.#signal.aborted) {
          onAbort();
        } else {
          this.#signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const waiter of this.#waiters) {
        this.#settle(waiter, undefined, new Error("login interrupted"));
      }
      this.#waiters = [];
      this.#server.close(() => resolve());
    });
  }

  #handle(rawUrl: string, response: ServerResponse): void {
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      respondHtml(response, 404, "<h1>Not found</h1>");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (error) {
      const description = url.searchParams.get("error_description") ?? "";
      respondHtml(response, 400, `<h1>Authorization failed</h1><p>${escapeHtml(error)}${description ? `: ${escapeHtml(description)}` : ""}</p>`);
      this.#failAll(new Error(`OAuth authorization error: ${error}${description ? ` (${description})` : ""}`));
      return;
    }
    if (!code) {
      respondHtml(response, 400, "<h1>Authorization failed</h1><p>No authorization code returned.</p>");
      this.#failAll(new Error("OAuth callback did not include an authorization code"));
      return;
    }
    if (this.#state !== undefined && state !== this.#state) {
      respondHtml(response, 400, "<h1>Authorization failed</h1><p>State mismatch; aborting.</p>");
      this.#failAll(new Error("OAuth callback state mismatch"));
      return;
    }
    respondHtml(response, 200, "<h1>Authorization complete</h1><p>You can close this window and return to the terminal.</p>");
    this.#settleAll(code);
  }

  #settleAll(code: string): void {
    for (const waiter of this.#waiters) this.#settle(waiter, code, undefined);
    this.#waiters = [];
  }

  #failAll(error: Error): void {
    for (const waiter of this.#waiters) this.#settle(waiter, undefined, error);
    this.#waiters = [];
  }

  #settle(waiter: Waiter, code: string | undefined, error: Error | undefined): void {
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
    if (error) waiter.reject(error);
    else if (code !== undefined) waiter.resolve(code);
  }
}

interface Waiter {
  resolve(code: string): void;
  reject(error: Error): void;
  timeout?: NodeJS.Timeout;
}

function respondHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

/** Rewrites opaque fetch failures (undici hides the cause) into a diagnosable message. */
function networkError(step: string, url: string, error: unknown): Error {
  const cause = error instanceof Error && (error as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause);
  const ownMessage = error instanceof Error ? error.message : undefined;
  const detail = causeMessage !== undefined ? ` (${causeMessage})`
    : ownMessage !== undefined ? ` (${ownMessage})` : "";
  let hint = "— check network/proxy access";
  // Node's fetch ignores system proxies unless NODE_USE_ENV_PROXY=1; a proxy
  // env var set without it is the most common "connect timeout" cause.
  const hasProxyEnv = typeof process.env.HTTPS_PROXY === "string" && process.env.HTTPS_PROXY.length > 0
    || typeof process.env.HTTP_PROXY === "string" && process.env.HTTP_PROXY.length > 0;
  if (hasProxyEnv && process.env.NODE_USE_ENV_PROXY !== "1") {
    hint += " — HTTPS_PROXY/HTTP_PROXY is set but NODE_USE_ENV_PROXY is not; run with NODE_USE_ENV_PROXY=1 to route fetch through your proxy";
  }
  return new Error(`failed to reach ${step} at ${url}${detail} ${hint}`, { cause: error });
}

/** Opens the system browser; resolves regardless of whether a browser exists. */
export async function openBrowser(url: string): Promise<void> {
  const command = buildOpenBrowserCommand(url);
  await new Promise<void>((resolve) => {
    const child = spawn(command.command, command.args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

export interface OpenBrowserCommand {
  readonly command: string;
  readonly args: string[];
  readonly windowsVerbatimArguments?: boolean;
}

/**
 * Builds the browser-open command. On Windows the URL must be quoted when
 * handed to `cmd /c start`: Node does not quote arguments without spaces, so
 * an unquoted authorization URL is split at every `&` (cmd's command
 * separator), truncating the query string and breaking the OAuth flow.
 */
export function buildOpenBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): OpenBrowserCommand {
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", '""', "/b", `"${url}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}
