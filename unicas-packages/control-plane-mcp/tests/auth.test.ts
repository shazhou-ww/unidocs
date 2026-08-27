import { describe, expect, test, vi } from "vitest";
import type {
  AuthRequest,
  CompleteAuthorizationOptions,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { OidcClient } from "@unicas/control-auth";
import {
  createOAuthAuthorizationHandler,
  type OAuthAuthorizationEnv,
} from "../src/auth.js";

const oauthRequest: AuthRequest = {
  responseType: "code",
  clientId: "https://copilot.example/client-metadata.json",
  redirectUri: "https://vscode.dev/redirect",
  scope: ["control:read", "control:security"],
  state: "client-state",
  codeChallenge: "client-pkce-challenge",
  codeChallengeMethod: "S256",
  resource: "https://cas.example/mcp",
  issuer: "https://cas.example",
};

describe("control-plane MCP OAuth authorization", () => {
  test("authenticates with Google, requires consent, and completes a scoped grant", async () => {
    const fixture = createFixture();
    const handler = createOAuthAuthorizationHandler({ oidcFactory: () => fixture.oidc });

    const started = await handler.fetch(new Request("https://cas.example/oauth/authorize"), fixture.env);
    expect(started.status).toBe(302);
    const googleLocation = new URL(started.headers.get("Location")!);
    const transactionId = googleLocation.searchParams.get("state")!;
    expect(googleLocation.origin).toBe("https://accounts.example");
    expect(googleLocation.searchParams.get("code_challenge_method")).toBe("S256");
    const authCookie = cookieFrom(started);
    expect(authCookie).toBe(`unicas_mcp_oauth=${transactionId}`);
    const encrypted = [...fixture.kv.values()][0]!;
    expect(encrypted).not.toContain(oauthRequest.clientId);
    expect(encrypted).not.toContain("client-state");

    const callback = await handler.fetch(new Request(
      `https://cas.example/oauth/google/callback?code=google-code&state=${transactionId}`,
      { headers: { Cookie: authCookie } },
    ), fixture.env);
    expect(callback.status).toBe(200);
    expect(callback.headers.get("Content-Type")).toContain("text/html");
    const consentHtml = await callback.text();
    expect(consentHtml).toContain("GitHub Copilot");
    expect(consentHtml).toContain("control:security");
    expect(consentHtml).toContain("Manage security settings");
    expect(consentHtml).toContain("class=\"panel\"");
    expect(consentHtml).toContain("@media (max-width: 520px)");
    expect(callback.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(callback.headers.get("Referrer-Policy")).toBe("no-referrer");
    const consentId = hiddenValue(consentHtml, "consent_id");
    const csrfToken = hiddenValue(consentHtml, "csrf_token");
    const consentCookie = cookieFrom(callback);

    const replay = await handler.fetch(new Request(
      `https://cas.example/oauth/google/callback?code=google-code&state=${transactionId}`,
      { headers: { Cookie: authCookie } },
    ), fixture.env);
    expect(replay.status).toBe(400);

    const approved = await handler.fetch(new Request("https://cas.example/oauth/authorize", {
      method: "POST",
      headers: {
        Cookie: consentCookie,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://cas.example",
      },
      body: new URLSearchParams({
        consent_id: consentId,
        csrf_token: csrfToken,
        decision: "approve",
      }),
    }), fixture.env);
    expect(approved.status).toBe(302);
    expect(approved.headers.get("Location")).toBe("https://vscode.dev/redirect?code=unicas-code");
    expect(fixture.completeAuthorization).toHaveBeenCalledTimes(1);
    const completed = fixture.completeAuthorization.mock.calls[0]![0];
    expect(completed.scope).toEqual(["control:read", "control:security"]);
    expect(completed.userId).not.toContain("alice-sub");
    expect(completed.metadata).not.toMatchObject({ clientId: oauthRequest.clientId });
    expect(completed.props).toEqual({
      identityIssuer: "https://accounts.example",
      subject: "alice-sub",
      displayName: "Alice",
      emailForDisplay: "alice@example.com",
      scopes: ["control:read", "control:security"],
      oauthClientId: oauthRequest.clientId,
      oauthClientHandle: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(completed.props)).not.toContain("google-access-token");
  });

  test("rejects a verified Google identity outside the current allowlist", async () => {
    const fixture = createFixture({ allowlist: "operator@example.com" });
    const handler = createOAuthAuthorizationHandler({ oidcFactory: () => fixture.oidc });
    const started = await handler.fetch(new Request("https://cas.example/oauth/authorize"), fixture.env);
    const transactionId = new URL(started.headers.get("Location")!).searchParams.get("state")!;
    const callback = await handler.fetch(new Request(
      `https://cas.example/oauth/google/callback?code=google-code&state=${transactionId}`,
      { headers: { Cookie: cookieFrom(started) } },
    ), fixture.env);

    expect(callback.status).toBe(403);
    expect(fixture.completeAuthorization).not.toHaveBeenCalled();
  });

  test("rejects unsupported scopes before starting Google authentication", async () => {
    const fixture = createFixture({ request: { ...oauthRequest, scope: ["control:read", "unknown"] } });
    const handler = createOAuthAuthorizationHandler({ oidcFactory: () => fixture.oidc });
    const response = await handler.fetch(new Request("https://cas.example/oauth/authorize"), fixture.env);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(fixture.kv.size).toBe(0);
  });

  test.each([
    ["same-origin fetch metadata", { "Sec-Fetch-Site": "same-origin" }, 302],
    ["same-origin referer", { Referer: "https://cas.example/oauth/authorize" }, 302],
    ["cross-origin request", { Origin: "https://attacker.example" }, 403],
    ["missing browser origin evidence", {}, 403],
  ])("handles consent origin evidence: %s", async (_name, originHeaders, expectedStatus) => {
    const fixture = createFixture();
    const handler = createOAuthAuthorizationHandler({ oidcFactory: () => fixture.oidc });
    const started = await handler.fetch(new Request("https://cas.example/oauth/authorize"), fixture.env);
    const transactionId = new URL(started.headers.get("Location")!).searchParams.get("state")!;
    const callback = await handler.fetch(new Request(
      `https://cas.example/oauth/google/callback?code=google-code&state=${transactionId}`,
      { headers: { Cookie: cookieFrom(started) } },
    ), fixture.env);
    const consentHtml = await callback.text();
    const headers = new Headers({
      Cookie: cookieFrom(callback),
      "Content-Type": "application/x-www-form-urlencoded",
      ...originHeaders,
    });
    const response = await handler.fetch(new Request("https://cas.example/oauth/authorize", {
      method: "POST",
      headers,
      body: new URLSearchParams({
        consent_id: hiddenValue(consentHtml, "consent_id"),
        csrf_token: hiddenValue(consentHtml, "csrf_token"),
        decision: "approve",
      }),
    }), fixture.env);

    expect(response.status).toBe(expectedStatus);
  });
});

function createFixture(options: { allowlist?: string; request?: AuthRequest } = {}) {
  const kv = new Map<string, string>();
  const completeAuthorization = vi.fn(async (_options: CompleteAuthorizationOptions) => ({
    redirectTo: "https://vscode.dev/redirect?code=unicas-code",
  }));
  const oauth = {
    parseAuthRequest: vi.fn(async () => options.request ?? oauthRequest),
    lookupClient: vi.fn(async () => ({
      clientId: oauthRequest.clientId,
      clientName: "GitHub Copilot",
      redirectUris: [oauthRequest.redirectUri],
      tokenEndpointAuthMethod: "none",
    })),
    completeAuthorization,
  } as unknown as OAuthHelpers;
  const oidc = {
    authorizationUrl: vi.fn(async (input: { state: string; nonce: string; codeChallenge: string }) => {
      const url = new URL("https://accounts.example/authorize");
      url.searchParams.set("state", input.state);
      url.searchParams.set("nonce", input.nonce);
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    }),
    exchangeCode: vi.fn(async () => ({
      idToken: "google-id-token",
      accessToken: "google-access-token",
    })),
    verifyIdToken: vi.fn(async () => ({
      sub: "alice-sub",
      email: "alice@example.com",
      emailVerified: true,
      name: "Alice",
    })),
  } as unknown as OidcClient;
  const stateKey = new Uint8Array(32);
  crypto.getRandomValues(stateKey);
  let binary = "";
  for (const byte of stateKey) binary += String.fromCharCode(byte);
  const env: OAuthAuthorizationEnv = {
    OAUTH_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
        kv.set(key, String(value));
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    } as unknown as KVNamespace,
    OAUTH_PROVIDER: oauth,
    PUBLIC_ORIGIN: "https://cas.example",
    OAUTH_STATE_ENCRYPTION_KEY: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    OIDC_ISSUER: "https://accounts.example",
    ADMIN_EMAIL_ALLOWLIST: options.allowlist,
  };
  return { env, kv, oidc, completeAuthorization };
}

function cookieFrom(response: Response): string {
  return response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
}

function hiddenValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!match) throw new Error(`hidden field ${name} not found`);
  return match[1]!;
}