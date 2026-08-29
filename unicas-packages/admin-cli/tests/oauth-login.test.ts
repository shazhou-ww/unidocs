import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { s256Challenge } from "@unicas/control-auth";
import { buildOpenBrowserCommand, runLoginFlow } from "../src/oauth/login.js";
import { TokenStore } from "../src/store.js";
import { FAKE_ORIGIN, FakeAdminApi } from "./helpers/fake-server.js";

let dir: string;
let store: TokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "unicas-cli-login-"));
  store = new TokenStore({ path: join(dir, "session.json") });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runLoginFlow", () => {
  test("authorizes through the BFF and exchanges the one-time code for a session", async () => {
    const admin = new FakeAdminApi();
    let resolveAuthorize: (url: URL) => void = () => undefined;
    const authorizeUrlPromise = new Promise<URL>((resolve) => {
      resolveAuthorize = resolve;
    });
    let callbackPort = 0;

    const flow = runLoginFlow({
      adminOrigin: FAKE_ORIGIN,
      store,
      openBrowser: false,
      fetchImpl: admin.fetch,
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
    expect(authorizeUrl.pathname).toBe("/admin/auth/cli/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("unicas-cli");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toContain(`127.0.0.1:${callbackPort}/callback`);
    expect(authorizeUrl.host).toBe(FAKE_ORIGIN.replace("https://", ""));

    // The BFF redirects the browser back to the loopback with a one-time code.
    const state = authorizeUrl.searchParams.get("state") ?? "";
    admin.cliCodeChallenge = authorizeUrl.searchParams.get("code_challenge") ?? null;
    const callbackResponse = await fetch(
      `http://127.0.0.1:${callbackPort}/callback?code=one-time-code-1&state=${state}`,
    );
    expect(callbackResponse.status).toBe(200);

    const outcome = await flowResult;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.identity?.emailForDisplay).toBe("alice@example.com");

    const session = await store.load();
    expect(session.adminOrigin).toBe(FAKE_ORIGIN);
    expect(session.cookie).toContain("cas_admin_session=");
    expect(session.csrfToken).toBe("cli-csrf-1");
    expect(session.identity?.subject).toBe("google-user-123");

    const exchange = admin.requests.find(
      (request) => request.pathname === "/admin/auth/cli/exchange" && request.method === "POST",
    );
    expect(exchange).toBeDefined();
    expect(exchange?.body).toMatchObject({ code: "one-time-code-1", codeVerifier: expect.any(String) });
  });

  test("rejects the callback when the state does not match", async () => {
    const admin = new FakeAdminApi();
    let callbackPort = 0;
    let resolveAuthorize: (url: URL) => void = () => undefined;
    const authorizeUrlPromise = new Promise<URL>((resolve) => {
      resolveAuthorize = resolve;
    });

    const flow = runLoginFlow({
      adminOrigin: FAKE_ORIGIN,
      store,
      openBrowser: false,
      fetchImpl: admin.fetch,
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

describe("buildOpenBrowserCommand", () => {
  test("quotes the authorization URL on Windows so cmd does not split at '&'", () => {
    const url = `${FAKE_ORIGIN}/admin/auth/cli/authorize?client_id=unicas-cli&code_challenge=abc`;
    const command = buildOpenBrowserCommand(url, "win32");
    expect(command.command).toBe("cmd");
    expect(command.windowsVerbatimArguments).toBe(true);
    expect(command.args).toEqual(["/c", "start", '""', "/b", `"${url}"`]);
    expect(command.args[4]).toContain("&code_challenge=abc");
  });

  test("passes the URL unmodified on macOS and Linux", () => {
    const url = `${FAKE_ORIGIN}/admin/auth/cli/authorize?client_id=unicas-cli`;
    expect(buildOpenBrowserCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(buildOpenBrowserCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
  });
});

test("s256Challenge produces a standards-compliant PKCE challenge", async () => {
  const challenge = await s256Challenge("test-verifier");
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
