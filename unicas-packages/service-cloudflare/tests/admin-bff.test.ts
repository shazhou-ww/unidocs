import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { s256Challenge } from "@unicas/control-auth";
import type {
  ControlPlaneCallContext,
  ControlPlaneOperations,
  ControlSessionRepository,
  StoredSession,
} from "@unicas/service";
import { createAdminBff, OidcClient, SessionCrypto } from "../src/admin-bff/index.js";
import type { AdminBffConfig } from "../src/admin-bff/config.js";

const PUBLIC_ORIGIN = "https://cas.example";
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const ISSUER = "https://mock-provider.example";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const AUTHORIZE_URL = `${ISSUER}/authorize`;
const TOKEN_URL = `${ISSUER}/token`;
const JWKS_URL = `${ISSUER}/jwks`;

interface FakeStack {
  stackId: string;
  displayName: string;
  description: string;
  status: "active";
  createdAt: number;
  revision: number;
  members: Map<string, ControlPlaneCallContext>;
}

const fakeStacks = new Map<string, FakeStack>();
const fakeSessions = new Map<string, StoredSession>();
let nextStackId = 1;

afterEach(() => {
  fakeStacks.clear();
  fakeSessions.clear();
  nextStackId = 1;
});

function identityKey(ctx: ControlPlaneCallContext): string {
  return `${ctx.identity.identityIssuer}\n${ctx.identity.subject}`;
}

class MemorySessionRepository implements ControlSessionRepository {
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  async create(sessionId: string, encryptedPayload: string, ttlMs: number): Promise<void> {
    const now = this.#now();
    fakeSessions.set(sessionId, { sessionId, encryptedPayload, expiresAt: now + ttlMs, createdAt: now, lastSeenAt: now });
  }

  async read(sessionId: string): Promise<StoredSession | null> {
    const session = fakeSessions.get(sessionId) ?? null;
    if (session && session.expiresAt <= this.#now()) {
      fakeSessions.delete(sessionId);
      return null;
    }
    return session;
  }

  async touch(sessionId: string, ttlMs: number): Promise<void> {
    const session = fakeSessions.get(sessionId);
    if (!session) return;
    const now = this.#now();
    fakeSessions.set(sessionId, { ...session, expiresAt: now + ttlMs, lastSeenAt: now });
  }

  async delete(sessionId: string): Promise<void> {
    fakeSessions.delete(sessionId);
  }

  async pruneExpired(): Promise<number> {
    const expired = [...fakeSessions.values()].filter((session) => session.expiresAt <= this.#now());
    for (const session of expired) fakeSessions.delete(session.sessionId);
    return expired.length;
  }
}

function fakeControlPlane(): ControlPlaneOperations {
  const error = async () => ({ error: "NOT_FOUND" as const, message: "not implemented by this BFF fake" });
  const requireStack = (ctx: ControlPlaneCallContext, stackId: string): FakeStack | null => {
    const stack = fakeStacks.get(stackId) ?? null;
    return stack?.members.has(identityKey(ctx)) ? stack : null;
  };
  return {
    me: async (ctx) => ({
      identity: {
        ...ctx.identity,
        displayName: ctx.profile?.displayName ?? null,
        emailForDisplay: ctx.profile?.emailForDisplay ?? null,
      },
      memberships: [...fakeStacks.values()]
        .filter((stack) => stack.members.has(identityKey(ctx)))
        .map((stack) => ({
          stackId: stack.stackId,
          ...ctx.identity,
          displayName: ctx.profile?.displayName ?? null,
          emailForDisplay: ctx.profile?.emailForDisplay ?? null,
        })),
    }),
    listStacks: async (ctx) => ({
      items: [...fakeStacks.values()]
        .filter((stack) => stack.members.has(identityKey(ctx)))
        .map(({ members: _members, ...stack }) => stack),
      nextCursor: null,
    }),
    createStack: async (ctx, request) => {
      const stack: FakeStack = {
        stackId: `cas_fake_${nextStackId++}`,
        displayName: request.body.displayName,
        description: "",
        status: "active",
        createdAt: Date.now(),
        revision: 1,
        members: new Map([[identityKey(ctx), ctx]]),
      };
      fakeStacks.set(stack.stackId, stack);
      const { members: _members, ...response } = stack;
      return response;
    },
    getStack: async (ctx, request) => {
      const stack = requireStack(ctx, request.path.stackId);
      if (!stack) return { error: "STACK_MEMBERSHIP_REQUIRED", message: "stack membership required" };
      const { members: _members, ...response } = stack;
      return response;
    },
    patchStack: async (ctx, request, mutation) => {
      const stack = requireStack(ctx, request.path.stackId);
      if (!stack) return { error: "STACK_MEMBERSHIP_REQUIRED", message: "stack membership required" };
      if (mutation.ifMatch !== `"${stack.revision}"`) {
        return { error: "REVISION_MISMATCH", message: "revision mismatch" };
      }
      stack.displayName = request.body.displayName ?? stack.displayName;
      stack.description = request.body.description ?? stack.description;
      stack.revision += 1;
      const { members: _members, ...response } = stack;
      return response;
    },
    listMembers: error as ControlPlaneOperations["listMembers"],
    deleteMember: error as ControlPlaneOperations["deleteMember"],
    createMemberInvitation: error as ControlPlaneOperations["createMemberInvitation"],
    acceptMemberInvitation: error as ControlPlaneOperations["acceptMemberInvitation"],
    getIssuer: error as ControlPlaneOperations["getIssuer"],
    putIssuer: async (ctx, request) => {
      if (!requireStack(ctx, request.path.stackId)) {
        return { error: "STACK_MEMBERSHIP_REQUIRED", message: "stack membership required" };
      }
      return {
        stackId: request.path.stackId,
        issuer: request.body.issuer,
        audience: request.body.audience,
        capabilityMaxLifetimeSeconds: request.body.capabilityMaxLifetimeSeconds ?? 28_800,
        revision: 1,
      };
    },
    createPossessionChallenge: async (ctx, request) => requireStack(ctx, request.stackId)
      ? { nonce: "fake-possession-nonce", expiresAt: Date.now() + 60_000 }
      : { error: "STACK_MEMBERSHIP_REQUIRED", message: "stack membership required" },
    listIssuerKeys: error as ControlPlaneOperations["listIssuerKeys"],
    createIssuerKey: error as ControlPlaneOperations["createIssuerKey"],
    deleteIssuerKey: error as ControlPlaneOperations["deleteIssuerKey"],
    listControlAuditEvents: error as ControlPlaneOperations["listControlAuditEvents"],
    recordSessionAudit: async () => undefined,
  };
}

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
  return createAdminBff({
    config,
    controlPlane: fakeControlPlane(),
    sessionStore: new MemorySessionRepository(config.now),
    oidc,
    auditReader,
  });
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

  test("CLI login: authorize redirects to Google, callback hands a one-time code, exchange issues a session", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const cliCodeChallenge = await s256Challenge("cli-verifier-1");

    // 1. CLI authorize: fixed public client id + loopback redirect + PKCE.
    const authorize = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/auth/cli/authorize?client_id=unicas-cli&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/callback")}&state=cli-state-1&code_challenge=${cliCodeChallenge}&code_challenge_method=S256`,
    ));
    expect(authorize.status).toBe(302);
    const preLoginCookie = cookieFrom(authorize)!;
    const googleUrl = new URL(authorize.headers.get("Location")!);
    expect(googleUrl.origin).toBe(ISSUER);
    // The BFF is a separate OAuth client of Google. Its PKCE transaction must
    // not reuse the CLI's challenge because Google later receives the BFF's
    // independently generated verifier.
    expect(googleUrl.searchParams.get("code_challenge")).not.toBe(cliCodeChallenge);
    const oidcState = googleUrl.searchParams.get("state")!;
    const nonce = googleUrl.searchParams.get("nonce")!;

    // 2. Google redirects back to the BFF callback.
    provider.pendingClaims = {
      iss: ISSUER,
      sub: "cli-user-1",
      aud: CLIENT_ID,
      nonce,
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
    };
    const callback = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/auth/callback?code=mock-code&state=${encodeURIComponent(oidcState)}`,
      { headers: { Cookie: preLoginCookie } },
    ));
    expect(callback.status).toBe(302);
    // The browser is redirected to the CLI's loopback with the one-time code.
    const redirect = new URL(callback.headers.get("Location")!);
    expect(redirect.origin + redirect.pathname).toBe("http://127.0.0.1:9999/callback");
    const oneTimeCode = redirect.searchParams.get("code")!;
    expect(redirect.searchParams.get("state")).toBe("cli-state-1");

    // 3. The CLI exchanges the code (PKCE) for a session.
    const challenge = await s256Challenge("cli-verifier-1");
    const exchange = await bff(new Request(`${PUBLIC_ORIGIN}/admin/auth/cli/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: oneTimeCode, codeVerifier: "cli-verifier-1" }),
    }));
    expect(exchange.status).toBe(200);
    const cookie = cookieFrom(exchange)!;
    const body = await exchange.json() as { csrfToken?: string; identity?: { subject?: string } };
    expect(body.csrfToken).toBeTruthy();
    expect(body.identity?.subject).toBe("cli-user-1");

    // 4. The issued session works for API reads.
    const me = await authRequest(bff, "/admin/me", cookie);
    expect(me.status).toBe(200);
  });

  test("CLI exchange rejects a wrong PKCE verifier", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const authorize = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/auth/cli/authorize?client_id=unicas-cli&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/callback")}&state=s&code_challenge=${await s256Challenge("real-verifier")}&code_challenge_method=S256`,
    ));
    const preLoginCookie = cookieFrom(authorize)!;
    const googleUrl = new URL(authorize.headers.get("Location")!);
    const nonce = googleUrl.searchParams.get("nonce")!;
    provider.pendingClaims = { iss: ISSUER, sub: "cli-user-1", aud: CLIENT_ID, nonce, email: "alice@example.com", email_verified: true };
    const callback = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/auth/callback?code=mock-code&state=${encodeURIComponent(googleUrl.searchParams.get("state")!)}`,
      { headers: { Cookie: preLoginCookie } },
    ));
    const oneTimeCode = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
    const exchange = await bff(new Request(`${PUBLIC_ORIGIN}/admin/auth/cli/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: oneTimeCode, codeVerifier: "wrong-verifier" }),
    }));
    expect(exchange.status).toBe(401);
  });

  test("CLI login returns OIDC failures to the loopback callback immediately", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const authorize = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/auth/cli/authorize?client_id=unicas-cli&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/callback")}&state=cli-state-failure&code_challenge=${await s256Challenge("cli-verifier")}&code_challenge_method=S256`,
    ));
    const preLoginCookie = cookieFrom(authorize)!;
    const googleUrl = new URL(authorize.headers.get("Location")!);
    provider.pendingClaims = {
      iss: ISSUER,
      sub: "cli-user-1",
      aud: CLIENT_ID,
      nonce: "wrong-nonce",
      email: "alice@example.com",
      email_verified: true,
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const callback = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/auth/callback?code=mock-code&state=${encodeURIComponent(googleUrl.searchParams.get("state")!)}`,
      { headers: { Cookie: preLoginCookie } },
    ));
    logged.mockRestore();

    expect(callback.status).toBe(302);
    const redirect = new URL(callback.headers.get("Location")!);
    expect(redirect.origin + redirect.pathname).toBe("http://127.0.0.1:9999/callback");
    expect(redirect.searchParams.get("error")).toBe("oidc_failed");
    expect(redirect.searchParams.get("error_description")).toContain("id_token_invalid");
    expect(redirect.searchParams.get("state")).toBe("cli-state-failure");
  });

  test("CLI exchange rejects an unknown one-time code", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const exchange = await bff(new Request(`${PUBLIC_ORIGIN}/admin/auth/cli/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "unknown-code", codeVerifier: "whatever" }),
    }));
    expect(exchange.status).toBe(401);
  });

  test("CLI authorize rejects a non-loopback redirect or unknown client", async () => {
    const provider = await createMockProvider();
    const bff = await createBff(provider);
    const badRedirect = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/auth/cli/authorize?client_id=unicas-cli&redirect_uri=${encodeURIComponent("https://evil.example/callback")}&state=s&code_challenge=c&code_challenge_method=S256`,
    ));
    expect(badRedirect.status).toBe(400);
    const badClient = await bff(new Request(
      `${PUBLIC_ORIGIN}/admin/auth/cli/authorize?client_id=other&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/callback")}&state=s&code_challenge=c&code_challenge_method=S256`,
    ));
    expect(badClient.status).toBe(400);
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
    const { cookie, csrf } = await signIn(bff, provider);

    const me = await authRequest(bff, "/admin/me", cookie);
    expect(me.status).toBe(200);
    expect(me.headers.get("X-CSRF-Token")).toBe(csrf);
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
  }, 10_000);

  test("email allowlist revokes a pre-existing session for an unlisted email", async () => {
    const provider = await createMockProvider();
    const sessionEncryptionKeys = { v1: randomKey() };
    const bff = await createBff(provider, undefined, {
      sessionEncryptionKeys,
      emailAllowlist: ["alice@example.com"],
    });
    const sessionStore = new MemorySessionRepository();
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
        identityIssuer: "urn:unicas:manage:test-account",
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
    expect(created.description).toBe("");
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

    const describe = await authRequest(bff, `/admin/stacks/${stackId}`, cookie, {
      method: "PATCH",
      headers: {
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
        "If-Match": '"2"',
      },
      body: JSON.stringify({ description: "Production documents" }),
    });
    expect(describe.status).toBe(200);
    expect(await describe.json()).toMatchObject({
      displayName: "Renamed",
      description: "Production documents",
      revision: 3,
    });

    const list = await authRequest(bff, "/admin/stacks", cookie);
    const listed = await list.json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].displayName).toBe("Renamed");
    expect(listed.items[0].description).toBe("Production documents");
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

  test("refDomain listing reads the observed audit catalog", async () => {
    const provider = await createMockProvider();
    const rpcCalls: URL[] = [];
    const auditReader = {
      fetch: async (input: RequestInfo | URL) => {
        rpcCalls.push(new URL(String(input)));
        return Response.json({
          domains: [{ stackId: "cas_stack", refDomain: "doc", revision: 3 }],
        });
      },
    };
    const bff = await createBff(provider, auditReader);
    const { cookie, csrf } = await signIn(bff, provider);
    const stackId = await createStack(bff, cookie, csrf, "Stack");

    const response = await authRequest(bff, `/admin/stacks/${stackId}/ref-domains`, cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      domains: [{ refDomain: "doc", revision: 3 }],
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.pathname).toBe("/_internal/audit/domains");
    expect(rpcCalls[0]!.searchParams.get("stackId")).toBe(stackId);
    expect(rpcCalls[0]!.searchParams.has("refDomain")).toBe(false);
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
  }, 10_000);

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
