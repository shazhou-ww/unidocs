import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { hashSessionSecret } from "../../src/auth.js";
import { portalGoogleConfigFromGateway } from "../../src/google-config.js";
import { TENANT_LOGIN_COOKIE } from "../../src/google-login.js";
import { D1TenantLoginRepository } from "../../src/tenant/login-repository.js";
import { createTenantLoginHttp } from "../../src/tenant/login-http.js";
import { D1TenantSessionStore, TENANT_CSRF_COOKIE, TENANT_SESSION_COOKIE } from "../../src/tenant/session.js";
import { insertMember } from "./members.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const config = portalGoogleConfigFromGateway({ GATEWAY_OIDC_CLIENT_ID: "tenant-client", GATEWAY_OIDC_CLIENT_SECRET: "fixture-secret" }, ORIGIN);
const discovery = {
  issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  code_challenge_methods_supported: ["S256"], response_types_supported: ["code"], subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"], authorization_response_iss_parameter_supported: true,
};

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: object[] };
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "google-test", alg: "RS256", use: "sig" }] };
});

let real: RealD1;
beforeEach(async () => { real = await startRealD1(); });
afterEach(async () => { await real.dispose(); vi.restoreAllMocks(); });

const now = () => Math.floor(Date.now() / 1000);

// `repository.take()` (called at the "state" stage, before any Google fetch)
// deletes the transaction row the instant the callback consumes it, so a
// token-endpoint double cannot re-query D1 for the nonce at sign time - by
// then it is already gone. `signIn` instead reads it out of D1 right after
// `begin()` stores it (before the callback's `take()` runs) and hands it to
// the double through this box.
let pendingNonce = "";

/** A Google double: discovery, JWKS, and a token endpoint that signs for whatever nonce the begin step stored. */
function google(claims: JWTPayload = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("openid-configuration")) return Response.json(discovery);
    if (url === discovery.jwks_uri) return Response.json(jwks);
    if (url === discovery.token_endpoint) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("redirect_uri")).toBe(`${ORIGIN}/portal/auth/callback`);
      const issuedAt = now();
      const idToken = await new SignJWT({
        iss: discovery.issuer, aud: config.clientId, sub: "google-subject", email: "member@example.com", email_verified: true,
        iat: issuedAt, exp: issuedAt + 3600, auth_time: issuedAt, nonce: pendingNonce, ...claims,
      }).setProtectedHeader({ alg: "RS256", kid: "google-test" }).sign(keys.privateKey);
      return Response.json({ access_token: "discarded", token_type: "Bearer", id_token: idToken });
    }
    throw new Error(`Unexpected endpoint ${url}`);
  });
}

function handler(googleFetch: typeof fetch, googleConfig = () => config) {
  return createTenantLoginHttp({ origin: ORIGIN, googleConfig, repository: new D1TenantLoginRepository(real.db, now), now, googleFetch });
}

async function signIn(handle: ReturnType<typeof handler>, returnTo = "/portal/#/d/doc-1") {
  const start = (await handle(new Request(`${ORIGIN}/portal/auth/login?returnTo=${encodeURIComponent(returnTo)}`), "req-begin"))!;
  expect(start.status).toBe(303);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const loginCookie = start.headers.get("set-cookie")!.split(";")[0];
  const row = await real.db.prepare("SELECT nonce FROM portal_tenant_login_transactions").first<{ nonce: string }>();
  pendingNonce = row!.nonce;
  return (await handle(new Request(
    `${ORIGIN}/portal/auth/callback?state=${state}&code=test-code&iss=${encodeURIComponent(discovery.issuer)}`,
    { headers: { cookie: loginCookie, "sec-fetch-site": "cross-site" } },
  ), "req-callback"))!;
}

function setCookie(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find(value => value.startsWith(`${name}=`));
}

describe("tenant login endpoints", () => {
  it("ignores other paths", async () => {
    expect(await handler(google())(new Request(`${ORIGIN}/portal/auth/session`), "req")).toBeNull();
  });

  it("answers 405 for a non-GET method", async () => {
    const response = await handler(google())(new Request(`${ORIGIN}/portal/auth/login`, { method: "POST" }), "req");
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("GET");
  });

  it("signs an invited member in, even though the callback is a cross-site navigation", async () => {
    await insertMember(real.db, { tenantId: "t1", principalId: "user:m", email: "member@example.com", bound: false, createdAt: now() - 60 });
    const callback = await signIn(handler(google()));
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/portal/#/d/doc-1`);
    expect(setCookie(callback, TENANT_LOGIN_COOKIE)).toContain("Max-Age=0");
    expect(setCookie(callback, TENANT_CSRF_COOKIE)).toMatch(/SameSite=Strict/);
    const token = setCookie(callback, TENANT_SESSION_COOKIE)!.split(";")[0].split("=")[1];
    const session = await new D1TenantSessionStore(real.db).find(await hashSessionSecret(token), now());
    expect(session).toMatchObject({ tenantId: "t1", principalId: "user:m" });
  });

  it("provisions a brand-new identity a tenant it was never granted, and signs it straight in", async () => {
    const callback = await signIn(handler(google()));
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/portal/#/d/doc-1`);
    expect(setCookie(callback, TENANT_LOGIN_COOKIE)).toContain("Max-Age=0");
    expect(setCookie(callback, TENANT_CSRF_COOKIE)).toMatch(/SameSite=Strict/);
    const token = setCookie(callback, TENANT_SESSION_COOKIE)!.split(";")[0].split("=")[1];
    const session = await new D1TenantSessionStore(real.db).find(await hashSessionSecret(token), now());
    expect(session?.tenantId).toMatch(/^t-/);
  });

  it("sends an email already active under a different Google identity back with login=denied", async () => {
    // "google-subject" is what `google()` signs the id token for; a different
    // subject already holds this email, so this identity may neither bind to
    // it nor provision a fresh tenant for it.
    await insertMember(real.db, { tenantId: "t1", principalId: "user:holder", email: "member@example.com" });
    const callback = await signIn(handler(google()));
    const location = new URL(callback.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${ORIGIN}/portal/`);
    expect(location.searchParams.get("login")).toBe("denied");
    expect(location.searchParams.get("requestId")).toBe("req-callback");
    expect(setCookie(callback, TENANT_SESSION_COOKIE)).toBeUndefined();
    expect(setCookie(callback, TENANT_LOGIN_COOKIE)).toContain("Max-Age=0");
  });

  it("sends a failed Google round trip back with login=failed and logs only stage and reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const callback = await signIn(handler(google({ email_verified: false })));
    expect(new URL(callback.headers.get("location")!).searchParams.get("login")).toBe("failed");
    const events = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(events).toEqual([expect.objectContaining({ event: "tenant_google_login_failed", requestId: "req-callback" })]);
    expect(Object.keys(events[0]).sort()).toEqual(["event", "reason", "requestId", "stage"]);
  });

  it("sends an invalid returnTo on begin back with login=failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = (await handler(google())(new Request(`${ORIGIN}/portal/auth/login?returnTo=${encodeURIComponent("https://attacker.example")}`), "req-bad"))!;
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.get("login")).toBe("failed");
  });

  it("answers login=unavailable when Google is not configured, on both endpoints", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = handler(google(), () => { throw new TypeError("Gateway Google OIDC client ID and secret are required"); });
    for (const path of ["/portal/auth/login", "/portal/auth/callback"]) {
      const response = (await handle(new Request(`${ORIGIN}${path}`), "req-u"))!;
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!).searchParams.get("login")).toBe("unavailable");
    }
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual(["tenant_login_not_configured", "tenant_login_not_configured"]);
  });

  it("logs an unexpected failure by name and message only", async () => {
    await insertMember(real.db, { tenantId: "t1", principalId: "user:m", email: "member@example.com", bound: false, createdAt: now() - 60 });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const repository = new D1TenantLoginRepository(real.db, now);
    vi.spyOn(repository, "completeLogin").mockRejectedValue(new Error("D1_ERROR: constraint failed"));
    const handle = createTenantLoginHttp({ origin: ORIGIN, googleConfig: () => config, repository, now, googleFetch: google() });
    const callback = await signIn(handle);
    expect(new URL(callback.headers.get("location")!).searchParams.get("login")).toBe("failed");
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{
      event: "tenant_operation_failed", requestId: "req-callback", path: "/portal/auth/callback", name: "Error", message: "D1_ERROR: constraint failed",
    }]);
  });
});
