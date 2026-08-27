import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runLoginFlow } from "../src/oauth/login.js";
import { PersistentOAuthClientProvider, NeedsLoginError } from "../src/oauth/provider.js";
import { TokenStore } from "../src/store.js";
import { FAKE_ORIGIN, FAKE_RESOURCE, FakeServer } from "./helpers/fake-server.js";

let dir: string;
let store: TokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "unicas-cli-login-"));
  store = new TokenStore({ path: join(dir, "token.json") });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runLoginFlow", () => {
  test("discovers, registers a public client, exchanges the code, and persists tokens", async () => {
    const server = new FakeServer();
    let resolveAuthorize: (url: URL) => void = () => undefined;
    const authorizeUrlPromise = new Promise<URL>((resolve) => {
      resolveAuthorize = resolve;
    });
    let callbackPort = 0;

    // Attach the outcome handler immediately so an early rejection is never
    // left unhandled while the test waits on the authorize URL.
    const flow = runLoginFlow({
      serverUrl: FAKE_RESOURCE,
      store,
      openBrowser: false,
      fetchImpl: server.fetch,
      log: () => undefined,
      onCallbackServerStarted: (port) => {
        callbackPort = port;
      },
      onAuthorizeUrl: (url) => resolveAuthorize(url),
    });
    const flowResult = flow.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const authorizeUrl = await authorizeUrlPromise;
    expect(callbackPort).toBeGreaterThan(0);
    expect(authorizeUrl.origin).toBe(FAKE_ORIGIN);
    expect(authorizeUrl.pathname).toBe("/oauth/authorize");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(authorizeUrl.searchParams.get("client_id")).toBe("cli-client-1");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toContain(`127.0.0.1:${callbackPort}/callback`);
    expect(authorizeUrl.searchParams.get("scope")).toContain("control:read");

    // Simulate the browser completing authorization with the right state.
    const state = authorizeUrl.searchParams.get("state") ?? "";
    const callbackResponse = await fetch(
      `http://127.0.0.1:${callbackPort}/callback?code=auth-code-1&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);

    const outcome = await flowResult;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = outcome.result;
    expect(result.clientId).toBe("cli-client-1");

    const session = await store.load();
    expect(session.serverUrl).toBe(FAKE_RESOURCE);
    expect(session.clientInformation?.client_id).toBe("cli-client-1");
    expect(session.tokens?.access_token).toContain("access-");
    expect(session.tokens?.refresh_token).toContain("refresh-");
    expect(session.discoveryState?.authorizationServerUrl).toBe(FAKE_ORIGIN);

    const pathnames = server.requests.map((request) => request.pathname);
    expect(pathnames).toContain("/.well-known/oauth-protected-resource");
    expect(pathnames).toContain("/.well-known/oauth-authorization-server");
    const registration = server.requests.find((request) => request.pathname === "/oauth/register");
    expect(registration).toBeDefined();
    expect((registration?.body as { token_endpoint_auth_method?: string })?.token_endpoint_auth_method).toBe("none");
    const exchange = server.requests.find((request) => request.pathname === "/oauth/token");
    expect(exchange).toBeDefined();
    const exchangeForm = new URLSearchParams(exchange?.rawBody ?? "");
    expect(exchangeForm.get("grant_type")).toBe("authorization_code");
    expect(exchangeForm.get("code")).toBe("auth-code-1");
    expect(exchangeForm.get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(exchangeForm.get("client_id")).toBe("cli-client-1");
  });

  test("rejects the callback when the state does not match", async () => {
    const server = new FakeServer();
    let callbackPort = 0;
    let resolveAuthorize: (url: URL) => void = () => undefined;
    const authorizeUrlPromise = new Promise<URL>((resolve) => {
      resolveAuthorize = resolve;
    });

    const flow = runLoginFlow({
      serverUrl: FAKE_RESOURCE,
      store,
      openBrowser: false,
      fetchImpl: server.fetch,
      log: () => undefined,
      onCallbackServerStarted: (port) => {
        callbackPort = port;
      },
      onAuthorizeUrl: (url) => resolveAuthorize(url),
    });
    const flowResult = flow.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await authorizeUrlPromise;
    const response = await fetch(
      `http://127.0.0.1:${callbackPort}/callback?code=evil-code&state=wrong-state`,
    );
    expect(response.status).toBe(400);
    const outcome = await flowResult;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect((outcome.error as Error).message).toMatch(/state mismatch/i);
  });
});

describe("PersistentOAuthClientProvider", () => {
  test("throws NeedsLoginError on redirect when non-interactive", async () => {
    const session = { serverUrl: FAKE_RESOURCE };
    const provider = new PersistentOAuthClientProvider({
      session,
      onSave: async () => undefined,
    });
    await expect(provider.redirectToAuthorization(new URL(`${FAKE_ORIGIN}/oauth/authorize`)))
      .rejects.toBeInstanceOf(NeedsLoginError);
  });

  test("persists client information, tokens, and discovery state through onSave", async () => {
    const session = { serverUrl: FAKE_RESOURCE };
    const provider = new PersistentOAuthClientProvider({
      session,
      onSave: (next) => store.save(next),
    });
    await provider.saveClientInformation({ client_id: "c2", token_endpoint_auth_method: "none" });
    await provider.saveTokens({ access_token: "at", refresh_token: "rt", token_type: "Bearer" });
    await provider.saveDiscoveryState({ authorizationServerUrl: FAKE_ORIGIN });

    const loaded = await store.load();
    expect(loaded.clientInformation?.client_id).toBe("c2");
    expect(loaded.tokens?.access_token).toBe("at");
    expect(loaded.discoveryState?.authorizationServerUrl).toBe(FAKE_ORIGIN);

    await provider.invalidateCredentials("tokens");
    const afterInvalidation = await store.load();
    expect(afterInvalidation.tokens).toBeUndefined();
    expect(afterInvalidation.clientInformation?.client_id).toBe("c2");
  });
});
