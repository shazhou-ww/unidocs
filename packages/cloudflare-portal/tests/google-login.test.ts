import { beforeAll, describe, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createPortalGoogleLogin, createTenantGoogleLogin, LOGIN_COOKIE, portalGoogleConfigFromGateway, portalReturnPath, TENANT_LOGIN_COOKIE, tenantReturnPath, type PortalLoginTransaction } from "../src/index.js";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: object[] };
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "google-test", alg: "RS256", use: "sig" }] };
});

const origin = "https://portal.example";
const config = portalGoogleConfigFromGateway({ GATEWAY_OIDC_CLIENT_ID: "existing-gateway-client", GATEWAY_OIDC_CLIENT_SECRET: "fixture-secret" }, origin);
const discovery = { issuer: config.issuer, authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs", code_challenge_methods_supported: ["S256"], response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], authorization_response_iss_parameter_supported: true };

async function setup(overrides: JWTPayload = {}, returnTo = "/admin/?tab=types#markdown") {
  const loginConfig = config;
  let now = Math.floor(Date.now() / 1000);
  const transactions = new Map<string, PortalLoginTransaction>();
  let transaction: PortalLoginTransaction;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const url = String(input);
    if (url.endsWith("openid-configuration")) return Response.json(discovery);
    if (url === discovery.jwks_uri) return Response.json(jwks);
    if (url === discovery.token_endpoint) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe(config.clientId);
      expect(body.get("client_secret")).toBe(config.clientSecret);
      expect(body.get("code_verifier")).toBe(transaction.verifier);
      expect(body.get("redirect_uri")).toBe(`${origin}/admin/auth/callback`);
      expect(body.get("grant_type")).toBe("authorization_code");
      const idToken = await new SignJWT({ iss: config.issuer, aud: config.clientId, sub: "google-subject", email: "admin@example.com", email_verified: true, iat: now, exp: now + 3600, auth_time: now, nonce: transaction.nonce, ...overrides })
        .setProtectedHeader({ alg: "RS256", kid: "google-test" }).sign(keys.privateKey);
      return Response.json({ access_token: "discarded-test-access-token", token_type: "Bearer", id_token: idToken });
    }
    throw new Error("Unexpected endpoint");
  });
  const login = createPortalGoogleLogin(loginConfig, {
    now: () => now,
    fetch: fetcher,
    put: async stored => { transaction = stored; transactions.set(stored.stateHash, stored); },
    take: async (stateHash, browserHash, time) => {
      const stored = transactions.get(stateHash);
      if (!stored || stored.browserHash !== browserHash || stored.expiresAt <= time) return null;
      transactions.delete(stateHash);
      return stored;
    },
  });
  const start = await login.begin(new Request(`${origin}/admin/auth/login?returnTo=${encodeURIComponent(returnTo)}`));
  const target = new URL(start.headers.get("location")!);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const callback = (query = "") => new Request(`${origin}/admin/auth/callback?state=${target.searchParams.get("state")}&code=test-code&iss=${encodeURIComponent(config.issuer)}${query}`, { headers: { cookie } });
  return { login, start, target, cookie, callback, fetcher, transactions, advance: (seconds: number) => { now += seconds; } };
}

describe("Portal Google authorization-code flow", () => {
  test("allows only the exact MCP authorization resume path as a shared-login return target", () => {
    const resume = `/oauth/admin-mcp/authorize?resume=${"a".repeat(43)}`;
    expect(portalReturnPath(resume)).toBe(resume);
    for (const invalid of [
      "/oauth/admin-mcp/authorize", `${resume}&next=https://attacker.example`,
      `/oauth/admin-mcp/authorize?resume=${"a".repeat(42)}`, "/oauth/admin-mcp/token",
    ]) expect(() => portalReturnPath(invalid)).toThrow();
  });

  test("the existing Admin Google callback returns to MCP authorization resume", async () => {
    const resume = `/oauth/admin-mcp/authorize?resume=${"a".repeat(43)}`;
    const current = await setup({}, resume);
    expect(current.target.searchParams.get("redirect_uri")).toBe(`${origin}/admin/auth/callback`);
    expect((await current.login.complete(current.callback())).returnTo).toBe(resume);
  });

  test("starts with existing Gateway client, independent callback, S256, nonce and browser binding", async () => {
    const { target, start, transactions } = await setup();
    expect(start.status).toBe(303);
    expect(target.searchParams.get("client_id")).toBe(config.clientId);
    expect(target.searchParams.get("redirect_uri")).toBe(`${origin}/admin/auth/callback`);
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("prompt")).toBe("select_account");
    expect(target.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(target.searchParams.has("max_age")).toBe(false);
    expect(target.searchParams.has("claims")).toBe(false);
    expect(target.href).not.toContain(config.clientSecret);
    expect(start.headers.get("set-cookie")).toContain(`${LOGIN_COOKIE}=`);
    expect(start.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax; Max-Age=600");
    expect(start.headers.get("cache-control")).toBe("no-store");
    const [stored] = transactions.values();
    expect(stored.stateHash).not.toBe(target.searchParams.get("state"));
    expect(target.searchParams.get("code_challenge")).not.toBe(stored.verifier);
  });

  test("validates the token signature and claims and consumes a callback only once", async () => {
    const { login, callback, fetcher } = await setup();
    const result = await login.complete(callback());
    expect(result.identity).toMatchObject({ issuer: config.issuer, subject: "google-subject", email: "admin@example.com" });
    expect(result.returnTo).toBe("/admin/?tab=types#markdown");
    expect(result.clearLoginCookie).toContain("Max-Age=0");
    expect(JSON.stringify(result)).not.toContain("discarded-test-access-token");
    const calls = fetcher.mock.calls.length;
    await expect(login.complete(callback())).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  test("concurrent callbacks exchange one code", async () => {
    const { login, callback, fetcher } = await setup();
    const results = await Promise.allSettled([login.complete(callback()), login.complete(callback())]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === discovery.token_endpoint)).toHaveLength(1);
  });

  test("wrong browser, expired state and duplicate parameters never exchange tokens", async () => {
    const { login, callback, fetcher, advance } = await setup();
    await expect(login.complete(new Request(callback().url))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(login.complete(callback("&code=duplicate"))).rejects.toMatchObject({ code: "unauthorized" });
    advance(600);
    await expect(login.complete(callback())).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetcher.mock.calls.filter(([url]) => String(url) === discovery.token_endpoint)).toHaveLength(0);
  });

  test.each([
    { nonce: "wrong" }, { aud: "other-client" }, { iss: "https://attacker.example" },
    { auth_time: "bad" }, { auth_time: Math.floor(Date.now() / 1000) + 3600 }, { email_verified: false }, { azp: "other-client" }, { iat: 1 }, { exp: 1 },
  ])("rejects invalid signed callback claims %#", async overrides => {
    const { login, callback, transactions } = await setup(overrides);
    await expect(login.complete(callback())).rejects.toMatchObject({ code: "unauthorized" });
    expect(transactions.size).toBe(0);
  });

  test("preserves old Google authentication time separately from fresh code confirmation", async () => {
    const authenticatedAt = Math.floor(Date.now() / 1000) - 3600;
    const { login, callback } = await setup({ auth_time: authenticatedAt });
    const result = await login.complete(callback());
    expect(result.identity.authenticatedAt).toBe(authenticatedAt);
    expect(result.identity.loginConfirmation).toBe("authorization-code-v1");
    expect(result.identity.loginConfirmedAt).toBeGreaterThan(authenticatedAt);
  });

  test("confirms a verified code flow without synthesizing missing Google auth_time", async () => {
    const { login, callback } = await setup({ auth_time: undefined });
    const result = await login.complete(callback());
    expect(result.identity).toMatchObject({ authenticatedAt: null, loginConfirmation: "authorization-code-v1" });
    expect(Number.isSafeInteger(result.identity.loginConfirmedAt)).toBe(true);
    await expect(login.complete(callback())).rejects.toMatchObject({ stage: "state" });
  });

  test("distinguishes invalid authentication time from malformed responses and state failures", async () => {
    const invalid = await setup({ auth_time: -1 });
    await expect(invalid.login.complete(invalid.callback())).rejects.toMatchObject({ stage: "token_response", reason: "validation_failed" });
    const wrongNonce = await setup({ nonce: "wrong" });
    await expect(wrongNonce.login.complete(wrongNonce.callback())).rejects.toMatchObject({ stage: "token_response", reason: "validation_failed" });
    const expired = await setup();
    expired.advance(600);
    await expect(expired.login.complete(expired.callback())).rejects.toMatchObject({ stage: "state", reason: "validation_failed" });
  });

  test("does not attach original upstream errors or secrets to diagnostics", async () => {
    const { login, callback, fetcher } = await setup();
    fetcher.mockRejectedValue(new Error("sensitive-provider-response"));
    const error = await login.complete(callback()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ stage: "discovery", reason: "validation_failed" });
    expect(JSON.stringify(error)).not.toContain("sensitive-provider-response");
    expect(JSON.stringify(error)).not.toContain(config.clientSecret);
    expect(error).not.toHaveProperty("cause");
  });

  test("rechecks freshness after network verification finishes", async () => {
    const { login, callback, fetcher, advance } = await setup();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (String(input) === discovery.jwks_uri) advance(601);
      return response;
    });
    await expect(login.complete(callback())).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("rejects a forged signature", async () => {
    const { login, callback, fetcher } = await setup();
    const attacker = await generateKeyPair("RS256");
    const fakeJwks = { keys: [{ ...await exportJWK(attacker.publicKey), kid: "google-test", alg: "RS256", use: "sig" }] };
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => String(input) === discovery.jwks_uri ? Response.json(fakeJwks) : original(input, init));
    await expect(login.complete(callback())).rejects.toMatchObject({ code: "unauthorized" });
  });

  test.each([302, 500])("rejects upstream status %s without following redirects or leaking errors", async status => {
    const { login, callback, fetcher } = await setup();
    fetcher.mockResolvedValue(new Response(config.clientSecret, { status, headers: { location: "https://attacker.example" } }));
    await expect(login.complete(callback())).rejects.toThrow("Administrator authentication is required");
  });

  test("cancels oversized responses and rejects discovery endpoint substitution", async () => {
    const { login, callback, fetcher } = await setup();
    let cancelled = false;
    fetcher.mockResolvedValue(new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(65_537)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } }));
    await expect(login.complete(callback())).rejects.toMatchObject({ code: "unauthorized" });
    expect(cancelled).toBe(true);
    fetcher.mockResolvedValue(Response.json({ ...discovery, token_endpoint: "https://attacker.example" }));
    await expect(login.begin(new Request(`${origin}/admin/auth/login`))).rejects.toMatchObject({ code: "unauthorized" });
  });

  test.each(["https://attacker.example", "//attacker.example", "/admin/../../evil", "/admin/\\evil", "/admin/auth/login", "/admin/auth/callback", "/other", "/admin/\nunsafe", "/admin/%61uth/login", "/admin/auth%2fcallback", "/admin/%252e%252e/evil", "/admin/%00unsafe", "/admin/%invalid", "/admin/auth"])("rejects unsafe return path %j", path => {
    expect(() => portalReturnPath(path)).toThrow();
  });
});

describe("Portal Google login configuration", () => {
  const ports = { now: () => 0, put: async () => {}, take: async () => null };
  const rawConfig = (loginOrigin: string) => ({ issuer: "https://accounts.google.com" as const, clientId: "client", clientSecret: "secret", origin: loginOrigin });

  // createPortalGoogleLogin has its own copy of the origin/issuer guard
  // (independent of portalGoogleConfigFromGateway) — this is what let a
  // config built for local development still get refused here even after
  // google-config.ts's own check was relaxed.
  test("accepts a loopback origin for local development", () => {
    expect(() => createPortalGoogleLogin(rawConfig("http://127.0.0.1:8795"), ports)).not.toThrow();
    expect(() => createPortalGoogleLogin(rawConfig("http://localhost:8795"), ports)).not.toThrow();
  });

  test.each(["http://portal.example", "http://127.0.0.1.evil.test:8795"])("refuses a non-loopback http origin %s", loginOrigin => {
    expect(() => createPortalGoogleLogin(rawConfig(loginOrigin), ports)).toThrow("Invalid Portal Google configuration");
  });

  // The origin allowance must not smuggle in an issuer allowance: a loopback
  // origin is otherwise fully valid here, so this is the case that pins
  // config.issuer !== GOOGLE_ISSUER staying in the guard on its own.
  test("refuses a non-Google issuer even for an otherwise-valid loopback origin", () => {
    expect(() => createPortalGoogleLogin({ ...rawConfig("http://127.0.0.1:8795"), issuer: "http://127.0.0.1:8793" as never }, ports)).toThrow("Invalid Portal Google configuration");
  });
});

describe("Tenant Google login surface", () => {
  const ports = (put: (transaction: PortalLoginTransaction) => void) => ({
    now: () => Math.floor(Date.now() / 1000),
    put: async (transaction: PortalLoginTransaction) => put(transaction),
    take: async () => null,
    fetch: vi.fn<typeof fetch>(async input => {
      if (String(input).endsWith("openid-configuration")) return Response.json(discovery);
      throw new Error("Unexpected endpoint");
    }),
  });

  test("begins on /portal/auth/login with its own callback and cookie", async () => {
    let stored: PortalLoginTransaction | undefined;
    const login = createTenantGoogleLogin(config, ports(transaction => { stored = transaction; }));
    const start = await login.begin(new Request(`${origin}/portal/auth/login?returnTo=${encodeURIComponent("/portal/#/d/doc-1")}`));
    const target = new URL(start.headers.get("location")!);
    expect(start.status).toBe(303);
    expect(target.searchParams.get("redirect_uri")).toBe(`${origin}/portal/auth/callback`);
    expect(start.headers.get("set-cookie")).toMatch(new RegExp(`^${TENANT_LOGIN_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$`));
    expect(stored?.returnTo).toBe("/portal/#/d/doc-1");
  });

  test("defaults the return path to /portal/", async () => {
    let stored: PortalLoginTransaction | undefined;
    const login = createTenantGoogleLogin(config, ports(transaction => { stored = transaction; }));
    await login.begin(new Request(`${origin}/portal/auth/login`));
    expect(stored?.returnTo).toBe("/portal/");
  });

  test("refuses the admin begin path", async () => {
    const login = createTenantGoogleLogin(config, ports(() => {}));
    await expect(login.begin(new Request(`${origin}/admin/auth/login`))).rejects.toThrow();
  });

  test("accepts a loopback origin, which the admin cookie name used to gate", () => {
    const local = portalGoogleConfigFromGateway({ GATEWAY_OIDC_CLIENT_ID: "c", GATEWAY_OIDC_CLIENT_SECRET: "s" }, "http://127.0.0.1:8795");
    expect(() => createTenantGoogleLogin(local, ports(() => {}))).not.toThrow();
  });

  test.each(["/portal/", "/portal/?tab=1", "/portal/#/d/doc-1/th-1/0", "/portal/index.html"])("accepts tenant return path %j", path => {
    expect(tenantReturnPath(path)).toBe(path);
  });

  test.each([
    "/portal", "/admin/", "https://attacker.example", "//attacker.example", "/portal/auth/login", "/portal/auth/callback",
    "/portal/auth", "/portal/../admin/", "/portal/\\evil", "/portal/%2e%2e/admin", "/portal/%61uth/login", "/portal/ space",
    "/portal/\nunsafe", `/portal/${"a".repeat(2050)}`,
  ])("rejects tenant return path %j", path => {
    expect(() => tenantReturnPath(path)).toThrow();
  });
});