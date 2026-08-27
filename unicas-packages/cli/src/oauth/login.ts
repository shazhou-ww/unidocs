/**
 * Interactive `unicas login`: RFC 9728/8414 discovery, RFC 7591 dynamic client
 * registration, S256 PKCE authorization with a local `127.0.0.1` callback
 * server, and token persistence.
 *
 * The SDK's `auth()` orchestrator performs discovery, dynamic client
 * registration, PKCE challenge generation, and token exchange; this module
 * supplies the local redirect server, browser opening, and state validation.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { PersistedSession, TokenStore } from "../store.js";
import { PersistentOAuthClientProvider } from "./provider.js";

export interface LoginFlowOptions {
  readonly serverUrl: string;
  readonly store: TokenStore;
  /** Requested scopes; defaults to all `control:*` scopes. */
  readonly scopes?: readonly string[];
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
  readonly clientId: string;
}

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

export async function runLoginFlow(options: LoginFlowOptions): Promise<LoginFlowResult> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const callback = new LocalCallbackServer(options.signal);
  await callback.start(options.port ?? 0);
  options.onCallbackServerStarted?.(callback.port);
  const redirectUrl = `http://127.0.0.1:${callback.port}/callback`;

  const clientMetadata: OAuthClientMetadata = {
    client_name: "Unicas CLI",
    redirect_uris: [redirectUrl],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: options.scopes?.join(" ") ?? undefined,
  };

  const session: PersistedSession = { serverUrl: options.serverUrl };
  const provider = new PersistentOAuthClientProvider({
    session,
    onSave: (next) => options.store.save(next),
    redirectUrl,
    clientMetadata,
    onRedirect: async (url) => {
      callback.captureAuthorizeUrl(url.toString());
      callback.captureState(url.searchParams.get("state") ?? undefined);
      options.onAuthorizeUrl?.(url);
      log("");
      log("Open this URL in your browser to authorize the Unicas CLI:");
      log(`  ${url.toString()}`);
      log("");
      if (options.openBrowser !== false) {
        await openBrowser(url.toString()).catch(() => {
          log("Could not open a browser automatically; copy the URL above.");
        });
      }
    },
  });

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const first = await auth(provider, {
    serverUrl: options.serverUrl,
    scope: options.scopes?.join(" "),
    fetchFn: fetchImpl,
  });
  if (first !== "REDIRECT") {
    throw new Error("Unexpected OAuth state: authorization did not require a redirect");
  }

  const code = await callback.waitForCode();
  await callback.close();

  const second = await auth(provider, {
    serverUrl: options.serverUrl,
    authorizationCode: code,
    scope: options.scopes?.join(" "),
    fetchFn: fetchImpl,
  });
  if (second !== "AUTHORIZED") {
    throw new Error("OAuth authorization did not complete");
  }
  await options.store.save(session);

  const clientId = session.clientInformation?.client_id ?? "";
  return { session, authorizationUrl: callback.authorizationUrl, clientId };
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

/** Opens the system browser; resolves regardless of whether a browser exists. */
export async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "win32"
    ? { command: "cmd", args: ["/c", "start", "", url] }
    : process.platform === "darwin"
      ? { command: "open", args: [url] }
      : { command: "xdg-open", args: [url] };
  await new Promise<void>((resolve) => {
    const child = spawn(command.command, command.args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}
