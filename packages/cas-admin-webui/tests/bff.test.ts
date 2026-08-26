import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { migrateControlSchema } from "@unidocs/cas-control-plane";
import { createAdminBff, OidcClient } from "../src/server/index.js";
import type { AdminBffConfig } from "../src/server/config.js";

const PUBLIC_ORIGIN = "https://cas.example";
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const ISSUER = "https://mock-provider.example";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const AUTHORIZE_URL = `${ISSUER}/authorize`;
const TOKEN_URL = `${ISSUER}/token`;
const JWKS_URL = `${ISSUER}/jwks`;

let miniflare: Miniflare | undefined;

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
});

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

interface MockProvider {
  readonly privateKey: CryptoKey;
  readonly publicJwk: Record<string, unknown>;
  /** Claims the provider puts in the id_token it issues (nonce must echo the
   *  authorization request). */
  pendingClaims: Record<string, unknown> | null;
  /** Signed id_token the provider would issue; set per test. */
  issueIdToken: (claims: Record<string, unknown>) => Promise<string>;
  /** Token endpoint assertions for the current test. */
  expectTokenBody: ((body: URLSearchParams) => void) | null;
}

async function createMockProvider(): Promise<MockProvider> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  return {
    privateKey,
    publicJwk,
    pendingClaims: null,
    issueIdToken: (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "mock-kid" })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(privateKey),
    expectTokenBody: null,
  };
}

async function createBff(provider: MockProvider): Promise<(request: Request) => Promise<Response>> {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "admin-bff-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "admin-bff-test-db" },
    }],
  }));
  await miniflare.ready;
  const db = await miniflare.getD1Database("DB", "admin-bff-test");
  await migrateControlSchema(db);

  const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    if (url.toString() === DISCOVERY_URL) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: AUTHORIZE_URL,
        token_endpoint: TOKEN_URL,
        jwks_uri: JWKS_URL,
      });
    }
    if (url.toString() === JWKS_URL) {
      return Response.json({ keys: [{ ...provider.publicJwk, kid: "mock-kid", alg: "RS256", use: "sig" }] });
    }
    if (url.toString() === TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (provider.expectTokenBody) provider.expectTokenBody(body);
      const idToken = await provider.issueIdToken(provider.pendingClaims!);
      return Response.json({ id_token: idToken, access_token: "mock-access" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const config: AdminBffConfig = {
    googleClientId: CLIENT_ID,
    googleClientSecret: CLIENT_SECRET,
    sessionEncryptionKeys: { v1: randomKey() },
    oidcIssuer: ISSUER,
    oidcDiscoveryUrl: DISCOVERY_URL,
    publicOrigin: PUBLIC_ORIGIN,
    sessionCookieSecure: false,
  };
  const oidc = new OidcClient(
    {
      issuer: ISSUER,
      discoveryUrl: DISCOVERY_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: `${PUBLIC_ORIGIN}/admin/oauth/callback`,
    },
    { fetchImpl: providerFetch },
  );
  return createAdminBff({ config, db, oidc });
}

function cookieFrom(response: Response): string | null {
  const setCookie = response.headers.get("Set-Cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0]!.trim();
}

function authRequest(
  bff: (request: Request) => Promise<Response>,
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  headers.set("Origin", PUBLIC_ORIGIN);
  return bff(new Request(`${PUBLIC_ORIGIN}${path}`, { ...init, headers }));
}

async function signIn(bff: (request: Request) => Promise<Response>, provider: MockProvider): Promise<{ cookie: string; csrf: string }> {
  // 1. Start login.
  const login = await bff(new Request(`${PUBLIC_ORIGIN}/admin/oauth/login?returnTo=/admin/`));
  expect(login.status).toBe(302);
  const preLoginCookie = cookieFrom(login)!;
  const location = new URL(login.headers.get("Location")!);
  expect(location.origin).toBe(ISSUER);
  const state = location.searchParams.get("state")!;
  const nonce = location.searchParams.get("nonce")!;
  const codeChallenge = location.searchParams.get("code_challenge")!;
  expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(state).toBeTruthy();
  expect(nonce).toBeTruthy();
  expect(codeChallenge).toBeTruthy();

  // 2. Provider issues an id_token (nonce echoed back).
  provider.pendingClaims = {
    iss: ISSUER,
    sub: "google-user-123",
    aud: CLIENT_ID,
    nonce,
    email: "alice@example.com",
    name: "Alice",
  };

  // 3. Callback with the authorization code.
  const callback = await bff(new Request(
    `${PUBLIC_ORIGIN}/admin/oauth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: preLoginCookie } },
  ));
  expect(callback.status).toBe(302);
  expect(callback.headers.get("Location")).toBe("/admin/");
  const cookie = cookieFrom(callback)!;

  // 4. Load the shell to obtain the CSRF token.
  const shell = await authRequest(bff, "/admin/", cookie);
  expect(shell.status).toBe(200);
  const html = await shell.text();
  const match = /<meta name="x-csrf-token" content="([^"]+)"/.exec(html);
  expect(match).not.toBeNull();
  return { cookie, csrf: match![1]! };
}

describe("cas-admin-webui BFF", () => {
  test("full OIDC login flow reaches me() with the verified identity", async () => {
    const provider = await createMockProvider();
    provider.expectTokenBody = (body) => {
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("mock-code");
      expect(body.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/admin/oauth/callback`);
      expect(body.get("client_id")).toBe(CLIENT_ID);
      expect(body.get("client_secret")).toBe(CLIENT_SECRET);
      expect(body.get("code_verifier")).toBeTruthy();
    };
    const bff = await createBff(provider);
    const { cookie } = await signIn(bff, provider);

    const me = await authRequest(bff, "/admin/me", cookie);
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body.identity).toMatchObject({
      identityIssuer: ISSUER,
      subject: "google-user-123",
      displayName: "Alice",
      emailForDisplay: "alice@example.com",
    });
    expect(body.memberships).toEqual([]);
  });

  test("callback with a mismatched state is rejected", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const login = await bff(new Request(`${PUBLIC_ORIGIN}/admin/oauth/login`));
    const cookie = cookieFrom(login)!;
    const callback = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/oauth/callback?code=code&state=wrong-state`,
      { headers: { Cookie: cookie } },
    ));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toContain("login-error");
  });

  test("id_token with a wrong nonce is rejected", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const login = await bff(new Request(`${PUBLIC_ORIGIN}/admin/oauth/login`));
    const cookie = cookieFrom(login)!;
    const location = new URL(login.headers.get("Location")!);
    const state = location.searchParams.get("state")!;
    provider.pendingClaims = {
      iss: ISSUER,
      sub: "google-user-123",
      aud: CLIENT_ID,
      nonce: "wrong-nonce",
      email: null,
      name: null,
    };
    const callback = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/oauth/callback?code=code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookie } },
    ));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toContain("login-error");
  });

  test("API routes require a session", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const me = await bff(new Request(`${PUBLIC_ORIGIN}/admin/me`));
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ error: "ADMIN_AUTH_REQUIRED" });
  });

  test("mutations require Origin + CSRF token", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const { cookie, csrf } = await signIn(bff, provider);

    const noCsrf = await authRequest(bff, "/admin/stacks", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Stack" }),
    });
    expect(noCsrf.status).toBe(403);

    const noOrigin = await bff(new Request(`${PUBLIC_ORIGIN}/admin/stacks`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Stack" }),
    }));
    expect(noOrigin.status).toBe(403);

    const ok = await authRequest(bff, "/admin/stacks", cookie, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Stack" }),
    });
    expect(ok.status).toBe(200);
    const created = await ok.json();
    expect(created.displayName).toBe("Stack");
    expect(created.stackId).toMatch(/^cas_/);
    expect(ok.headers.get("ETag")).toBe('"1"');
  });

  test("stack lifecycle through the BFF with ETags", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const { cookie, csrf } = await signIn(bff, provider);

    const create = await authRequest(bff, "/admin/stacks", cookie, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "My Stack" }),
    });
    const stack = await create.json();
    const stackId = stack.stackId;

    const get = await authRequest(bff, `/admin/stacks/${stackId}`, cookie);
    expect(get.status).toBe(200);
    expect(get.headers.get("ETag")).toBe('"1"');

    // Stale If-Match → 412.
    const stale = await authRequest(bff, `/admin/stacks/${stackId}`, cookie, {
      method: "PATCH",
      headers: {
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
        "If-Match": '"99"',
      },
      body: JSON.stringify({ displayName: "Renamed" }),
    });
    expect(stale.status).toBe(412);

    const patch = await authRequest(bff, `/admin/stacks/${stackId}`, cookie, {
      method: "PATCH",
      headers: {
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
        "If-Match": '"1"',
      },
      body: JSON.stringify({ displayName: "Renamed" }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).displayName).toBe("Renamed");

    const list = await authRequest(bff, "/admin/stacks", cookie);
    const listed = await list.json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].displayName).toBe("Renamed");
  });

  test("invitation page redirects unauthenticated visitors to login, then to the hash route", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const page = await bff(new Request(`${PUBLIC_ORIGIN}/admin/invitations/token-abc`));
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toContain("/admin/oauth/login");
    expect(page.headers.get("Location")).toContain("returnTo=%2Fadmin%2Finvitations%2Ftoken-abc");

    const { cookie } = await signIn(bff, provider);
    const authed = await authRequest(bff, "/admin/invitations/token-abc", cookie);
    expect(authed.status).toBe(302);
    expect(authed.headers.get("Location")).toBe("/admin/#/invitations/token-abc");
  });

  test("root-ref audit routes are not available yet", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const { cookie, csrf } = await signIn(bff, provider);
    const stackId = await createStack(bff, cookie, csrf, "Stack");
    const audit = await authRequest(
      bff,
      `/admin/stacks/${stackId}/root-ref-domains/doc/refs`,
      cookie,
    );
    expect(audit.status).toBe(503);
    expect(await audit.json()).toMatchObject({ error: "SERVICE_UNAVAILABLE" });
  });

  test("possession challenge route requires session and CSRF", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const { cookie, csrf } = await signIn(bff, provider);
    const stackId = await createStack(bff, cookie, csrf, "Stack");
    // An issuer must exist before a key challenge can be minted.
    const issuer = await authRequest(bff, `/admin/stacks/${stackId}/issuer`, cookie, {
      method: "PUT",
      headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ issuer: "https://tenant-issuer.example", audience: "unidocs-cas" }),
    });
    expect(issuer.status).toBe(200);

    const noCsrf = await authRequest(bff, "/admin/issuer/possession-challenge", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stackId, kid: "k1", algorithm: "ES256" }),
    });
    expect(noCsrf.status).toBe(403);

    const ok = await authRequest(bff, "/admin/issuer/possession-challenge", cookie, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ stackId, kid: "k1", algorithm: "ES256" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ nonce: expect.any(String) });
  });

  test("logout clears the session", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const { cookie } = await signIn(bff, provider);
    const logout = await authRequest(bff, "/admin/oauth/logout", cookie, { method: "POST" });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const me = await authRequest(bff, "/admin/me", cookie);
    expect(me.status).toBe(401);
  });

  test("tenant JWT bearer tokens are not accepted on admin routes", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const me = await bff(new Request(`${PUBLIC_ORIGIN}/admin/me`, {
      headers: { Authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.eyJ0ZW5hbnRJZCI6InQifQ.signature" },
    }));
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ error: "ADMIN_AUTH_REQUIRED" });
  });
});

async function createStack(
  bff: (request: Request) => Promise<Response>,
  cookie: string,
  csrf: string,
  displayName: string,
): Promise<string> {
  const create = await authRequest(bff, "/admin/stacks", cookie, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  const body = await create.json();
  if (create.status !== 200) throw new Error(`createStack failed: ${JSON.stringify(body)}`);
  return body.stackId;
}
