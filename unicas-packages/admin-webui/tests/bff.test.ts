import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ControlSessionStore, migrateControlSchema } from "@unicas/control-plane";
import { createAdminBff, OidcClient, SessionCrypto } from "../src/server/index.js";
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

async function createBff(
  provider: MockProvider,
  auditReader?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
  configOverrides: Partial<AdminBffConfig> = {},
): Promise<(request: Request) => Promise<Response>> {
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
    auditReaderKey: "audit-reader-secret",
    ...configOverrides,
  };
  const oidc = new OidcClient(
    {
      issuer: ISSUER,
      discoveryUrl: DISCOVERY_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: `${PUBLIC_ORIGIN}/admin/auth/callback`,
    },
    { fetchImpl: providerFetch },
  );
  return createAdminBff({ config, db, oidc, auditReader });
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
  const login = await bff(new Request(`${PUBLIC_ORIGIN}/admin/auth/oidc?returnTo=/admin/`));
  expect(login.status).toBe(302);
  const preLoginCookie = cookieFrom(login)!;
  const location = new URL(login.headers.get("Location")!);
  expect(location.origin).toBe(ISSUER);
  const state = location.searchParams.get("state")!;
  const nonce = location.searchParams.get("nonce")!;
  const codeChallenge = location.searchParams.get("code_challenge")!;
  expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("prompt")).toBe("select_account");
  expect(location.searchParams.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/admin/auth/callback`);
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
    email_verified: true,
    name: "Alice",
  };

  // 3. Callback with the authorization code.
  const callback = await bff(new Request(
    `${PUBLIC_ORIGIN}/admin/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
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

/** Sign in as an arbitrary Google subject (for non-member checks). */
async function signInAs(
  bff: (request: Request) => Promise<Response>,
  provider: MockProvider,
  subject: string,
): Promise<{ cookie: string; csrf: string }> {
  const login = await bff(new Request(`${PUBLIC_ORIGIN}/admin/auth/oidc?returnTo=/admin/`));
  const preLoginCookie = cookieFrom(login)!;
  const location = new URL(login.headers.get("Location")!);
  const state = location.searchParams.get("state")!;
  const nonce = location.searchParams.get("nonce")!;
  provider.pendingClaims = {
    iss: ISSUER,
    sub: subject,
    aud: CLIENT_ID,
    nonce,
    email: `${subject}@example.com`,
    email_verified: true,
    name: subject,
  };
  const callback = await bff(new Request(
    `${PUBLIC_ORIGIN}/admin/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: preLoginCookie } },
  ));
  const cookie = cookieFrom(callback)!;
  const shell = await authRequest(bff, "/admin/", cookie);
  const html = await shell.text();
  const match = /<meta name="x-csrf-token" content="([^"]+)"/.exec(html);
  return { cookie, csrf: match![1]! };
}

describe("cas-admin-webui BFF", () => {
  test("unauthenticated visitors land on a login page before OIDC", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);

    const shell = await bff(new Request(`${PUBLIC_ORIGIN}/admin/`));
    expect(shell.status).toBe(302);
    expect(shell.headers.get("Location")).toBe("/admin/auth/login?returnTo=%2Fadmin%2F");

    const login = await bff(new Request(`${PUBLIC_ORIGIN}${shell.headers.get("Location")!}`));
    expect(login.status).toBe(200);
    expect(login.headers.get("Location")).toBeNull();
    expect(login.headers.get("Set-Cookie")).toBeNull();
    const html = await login.text();
    expect(html).toContain("Sign in");
    expect(html).toContain("/admin/auth/oidc?returnTo=%2Fadmin%2F");
    expect(html).toContain("Continue with Google");
  });

  test("full OIDC login flow reaches me() with the verified identity", async () => {
    const provider = await createMockProvider();
    provider.expectTokenBody = (body) => {
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("mock-code");
      expect(body.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/admin/auth/callback`);
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

  test("email allowlist accepts verified emails case-insensitively", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider, undefined, {
      emailAllowlist: ["ALICE@EXAMPLE.COM"],
    });
    const { cookie } = await signIn(bff, provider);

    const me = await authRequest(bff, "/admin/me", cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      identity: { emailForDisplay: "alice@example.com" },
    });
  });

  test("email allowlist rejects absent, unverified, or unlisted OIDC emails", async () => {
    for (const claims of [
      { email: null, email_verified: false },
      { email: "alice@example.com", email_verified: false },
      { email: "mallory@example.com", email_verified: true },
    ]) {
      const provider = await createMockProvider();
      const bff = await createBff(provider, undefined, {
        emailAllowlist: ["alice@example.com"],
      });
      const login = await bff(new Request(`${PUBLIC_ORIGIN}/admin/auth/oidc`));
      const cookie = cookieFrom(login)!;
      const location = new URL(login.headers.get("Location")!);
      const state = location.searchParams.get("state")!;
      provider.pendingClaims = {
        iss: ISSUER,
        sub: "google-user-123",
        aud: CLIENT_ID,
        nonce: location.searchParams.get("nonce")!,
        name: "Alice",
        ...claims,
      };

      const callback = await bff(new Request(
        `${PUBLIC_ORIGIN}/admin/auth/callback?code=mock-code&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: cookie } },
      ));
      expect(callback.status).toBe(302);
      expect(callback.headers.get("Location")).toBe("/admin/auth/login?error=not-allowed");
      expect(callback.headers.get("Set-Cookie")).toBeNull();

      const errorPage = await bff(new Request(`${PUBLIC_ORIGIN}${callback.headers.get("Location")!}`));
      expect(errorPage.status).toBe(200);
      expect(errorPage.headers.get("Location")).toBeNull();
      const errorHtml = await errorPage.text();
      expect(errorHtml).toContain("Access restricted");
      expect(errorHtml).toContain("not approved for this console");
      expect(errorHtml).toContain("Choose another Google account");
      expect(errorHtml).not.toContain("Continue with Google");
    }
  });

  test("email allowlist revokes a pre-existing session for an unlisted email", async () => {
    const provider = await createMockProvider();
    const sessionEncryptionKeys = { v1: randomKey() };
    const bff = await createBff(provider, undefined, {
      sessionEncryptionKeys,
      emailAllowlist: ["alice@example.com"],
    });
    const db = await miniflare!.getD1Database("DB", "admin-bff-test");
    const sessionStore = new ControlSessionStore(db);
    const sessionId = "sess_preexisting_unlisted";
    const encryptedPayload = await new SessionCrypto(sessionEncryptionKeys).encrypt({
      v: 1,
      authenticated: true,
      identityIssuer: ISSUER,
      subject: "google-user-before-allowlist",
      displayName: "Mallory",
      emailForDisplay: "mallory@example.com",
      csrfToken: "old-csrf-token",
    });
    await sessionStore.create(sessionId, encryptedPayload, 8 * 60 * 60 * 1000);
    const cookie = `cas_admin_session=${sessionId}`;

    const shell = await authRequest(bff, "/admin/", cookie);
    expect(shell.status).toBe(302);
    expect(shell.headers.get("Location")).toContain("/admin/auth/login");
    await expect(sessionStore.read(sessionId)).resolves.toBeNull();

    const me = await authRequest(bff, "/admin/me", cookie);
    expect(me.status).toBe(401);
  });

  test("configured test account bypasses OIDC and creates a normal admin session", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider, undefined, {
      testAccount: { email: "tester@example.com", password: "test-password" },
      emailAllowlist: ["tester@example.com"],
    });
    const loginUrl = `${PUBLIC_ORIGIN}/admin/auth/login?test-account=1&returnTo=/admin/`;

    const challenge = await bff(new Request(loginUrl));
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("WWW-Authenticate")).toContain("Basic");

    const rejected = await bff(new Request(loginUrl, {
      headers: { Authorization: `Basic ${btoa("tester@example.com:wrong")}` },
    }));
    expect(rejected.status).toBe(401);

    const login = await bff(new Request(loginUrl, {
      headers: { Authorization: `Basic ${btoa("TESTER@example.com:test-password")}` },
    }));
    expect(login.status).toBe(302);
    expect(login.headers.get("Location")).toBe("/admin/");
    const cookie = cookieFrom(login)!;

    const me = await authRequest(bff, "/admin/me", cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      identity: {
        identityIssuer: "urn:unicas:admin:test-account",
        subject: "tester@example.com",
        emailForDisplay: "tester@example.com",
      },
    });
  });

  test("callback with a mismatched state is rejected", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const login = await bff(new Request(`${PUBLIC_ORIGIN}/admin/auth/oidc`));
    const cookie = cookieFrom(login)!;
    const callback = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/auth/callback?code=code&state=wrong-state`,
      { headers: { Cookie: cookie } },
    ));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/admin/auth/login?error=oidc-failed");
  });

  test("id_token with a wrong nonce is rejected", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const login = await bff(new Request(`${PUBLIC_ORIGIN}/admin/auth/oidc`));
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
      `${PUBLIC_ORIGIN}/admin/auth/callback?code=code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookie } },
    ));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/admin/auth/login?error=oidc-failed");
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
    expect(page.headers.get("Location")).toContain("/admin/auth/login");
    expect(page.headers.get("Location")).toContain("returnTo=%2Fadmin%2Finvitations%2Ftoken-abc");

    const { cookie } = await signIn(bff, provider);
    const authed = await authRequest(bff, "/admin/invitations/token-abc", cookie);
    expect(authed.status).toBe(302);
    expect(authed.headers.get("Location")).toBe("/admin/#/invitations/token-abc");
  });

  test("root-ref audit routes are not available yet without the reader binding", async () => {
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

  test("root-ref audit reads forward to the private reader RPC after membership", async () => {
    const provider = await createMockProvider();
    let rpcCalls: { url: URL; key: string }[] = [];
    const auditReader = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        rpcCalls.push({
          url: new URL(String(input)),
          key: new Headers(init?.headers).get("X-CAS-Audit-Reader-Key") ?? "",
        });
        return Response.json({ revision: 1, refs: [{ tenantId: "t", hash: "a".repeat(64), count: 3 }], nextCursor: null });
      },
    };
    const bff = await createBff(provider, auditReader);
    const { cookie, csrf } = await signIn(bff, provider);
    const stackId = await createStack(bff, cookie, csrf, "Stack");

    const refs = await authRequest(
      bff,
      `/admin/stacks/${stackId}/root-ref-domains/doc/refs?tenantId=tenant-1&limit=50`,
      cookie,
    );
    expect(refs.status).toBe(200);
    expect(await refs.json()).toMatchObject({ revision: 1, refs: [{ tenantId: "t", count: 3 }] });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.url.pathname).toBe("/_internal/audit/refs");
    expect(rpcCalls[0]!.url.searchParams.get("stackId")).toBe(stackId);
    expect(rpcCalls[0]!.url.searchParams.get("refDomain")).toBe("doc");
    expect(rpcCalls[0]!.url.searchParams.get("tenantId")).toBe("tenant-1");
    expect(rpcCalls[0]!.url.searchParams.get("limit")).toBe("50");
    expect(rpcCalls[0]!.key).toBe("audit-reader-secret");

    const events = await authRequest(
      bff,
      `/admin/stacks/${stackId}/root-ref-domains/doc/events?after=7`,
      cookie,
    );
    expect(events.status).toBe(200);
    expect(rpcCalls[1]!.url.pathname).toBe("/_internal/audit/events");
    expect(rpcCalls[1]!.url.searchParams.get("after")).toBe("7");
  });

  test("audit reads require stack membership before touching the reader", async () => {
    const provider = await createMockProvider();
    let readerCalls = 0;
    const auditReader = {
      fetch: async () => {
        readerCalls += 1;
        return Response.json({ revision: 0, refs: [], nextCursor: null });
      },
    };
    const bff = await createBff(provider, auditReader);
    const { cookie, csrf } = await signIn(bff, provider);
    const stackId = await createStack(bff, cookie, csrf, "Stack");
    // A different operator who is not a member cannot read audit.
    const provider2 = await createMockProvider();
    const bff2 = await createBff(provider2, auditReader);
    const { cookie: otherCookie } = await signInAs(bff2, provider2, "other-sub");
    const denied = await authRequest(
      bff2,
      `/admin/stacks/${stackId}/root-ref-domains/doc/refs`,
      otherCookie,
    );
    expect(denied.status).toBe(403);
    expect(readerCalls).toBe(0);
  });

  test("malformed refDomains are rejected before the reader; reserved domains are readable", async () => {
    const provider = await createMockProvider();
    const rpcPaths: string[] = [];
    const auditReader = {
      fetch: async (input: RequestInfo | URL) => {
        rpcPaths.push(new URL(String(input)).pathname);
        return Response.json({ revision: 0, refs: [], nextCursor: null });
      },
    };
    const bff = await createBff(provider, auditReader);
    const { cookie, csrf } = await signIn(bff, provider);
    const stackId = await createStack(bff, cookie, csrf, "Stack");

    const malformed = await authRequest(
      bff,
      `/admin/stacks/${stackId}/root-ref-domains/Bad%20Domain/refs`,
      cookie,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "INVALID_REQUEST" });

    const legacy = await authRequest(
      bff,
      `/admin/stacks/${stackId}/root-ref-domains/_legacy/refs`,
      cookie,
    );
    expect(legacy.status).toBe(200);
    expect(rpcPaths).toEqual(["/_internal/audit/refs"]);
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
    const logout = await authRequest(bff, "/admin/auth/logout", cookie, { method: "POST" });
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
