import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { createCloudflareGatewayOAuthIdentity, type GoogleLoginReplayStore } from "../src/oauth-identity.js";

it("only exposes management identity after verified, browser-bound, single-use Google login", async () => {
  const issuer = "https://accounts.google.com";
  const origin = "https://app.test";
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const pending = new Map<string, number>();
  const store: GoogleLoginReplayStore = {
    async register(nonce, expiresAt) { pending.set(nonce, expiresAt); },
    async consume(nonce, timestamp) { const expires = pending.get(nonce); pending.delete(nonce); return Boolean(expires && expires > timestamp); },
  };
  let nonce = "";
  let emailVerified = true;
  let includeAuthTime = true;
  let subject = "google-self";
  let issuedAtOffset = 0;
  let includeIssuedAt = true;
  let exchanges = 0;
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...publicJwk, kid: "google", alg: "RS256", use: "sig" }] });
    if (url.endsWith("/token")) {
      exchanges += 1;
      const builder = new SignJWT({ nonce, email: "shazhou.ww@gmail.com", email_verified: emailVerified, ...(includeAuthTime ? { auth_time: Math.floor(Date.now() / 1000) } : {}) })
        .setProtectedHeader({ alg: "RS256", kid: "google" }).setIssuer(issuer).setAudience("existing-client").setSubject(subject).setExpirationTime("1h");
      if (includeIssuedAt) builder.setIssuedAt(Math.floor(Date.now() / 1000) + issuedAtOffset);
      const token = await builder.sign(privateKey);
      return Response.json({ id_token: token });
    }
    throw new Error("Unexpected upstream request");
  }) as typeof fetch;
  try {
    const bindings = { GATEWAY_OIDC_CLIENT_ID: "existing-client", GATEWAY_OIDC_ISSUER: issuer, GATEWAY_PUBLIC_ORIGIN: origin, GATEWAY_SESSION_ENCRYPTION_KEY: "existing-gateway-secret", GATEWAY_OIDC_REDIRECT_PATH: "/oauth/unidocs-cloudflare/login/callback" };
    const google = createCloudflareGatewayOAuthIdentity(bindings, `${origin}/oauth/unidocs-cloudflare`, store);
    const start = async () => {
      const redirect = google.managementAuthenticationRequired(new Request(`${origin}/admin/`));
      const started = (await google.handleLogin(new Request(redirect.headers.get("Location")!)))!;
      const target = new URL(started.headers.get("Location")!);
      expect(target.searchParams.get("client_id")).toBe("existing-client");
      expect(target.searchParams.get("redirect_uri")).toBe(`${origin}/oauth/unidocs-cloudflare/login/callback`);
      expect(target.searchParams.get("max_age")).toBeNull();
      expect(target.searchParams.get("prompt")).toBe("select_account");
      nonce = target.searchParams.get("nonce")!;
      return { callback: `${origin}/oauth/unidocs-cloudflare/login/callback?code=code&state=${encodeURIComponent(target.searchParams.get("state")!)}`, cookie: started.headers.get("Set-Cookie")!.split(";")[0]! };
    };
    const first = await start();
    expect((await google.handleLogin(new Request(first.callback)))!.status).toBe(400);
    expect(exchanges).toBe(0);
    const response = (await google.handleLogin(new Request(first.callback, { headers: { Cookie: first.cookie } })))!;
    expect(response.status).toBe(303);
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0]!;
    const authenticated = new Request(`${origin}/admin/auth/session`, { headers: { Cookie: cookie } });
    expect(await google.currentGoogleLogin(authenticated)).toMatchObject({ issuer, subject: "google-self", email: "shazhou.ww@gmail.com", emailVerified: true, loginId: nonce });
    expect((await google.handleLogin(new Request(first.callback, { headers: { Cookie: first.cookie } })))!.status).toBe(400);
    expect(exchanges).toBe(1);
    expect(await google.currentGoogleLogin(new Request("https://other.test/admin/", { headers: { Cookie: cookie } }))).toBeNull();
    emailVerified = false;
    const second = await start();
    const unverified = (await google.handleLogin(new Request(second.callback, { headers: { Cookie: second.cookie } })))!;
    expect(await google.currentGoogleLogin(new Request(`${origin}/admin/`, { headers: { Cookie: unverified.headers.get("Set-Cookie")!.split(";")[0]! } }))).toBeNull();
    emailVerified = true; includeAuthTime = false;
    const missingTime = await start();
    const confirmed = (await google.handleLogin(new Request(missingTime.callback, { headers: { Cookie: missingTime.cookie } })))!;
    expect(confirmed.status).toBe(303);
    const confirmedRequest = new Request(`${origin}/admin/`, { headers: { Cookie: confirmed.headers.get("Set-Cookie")!.split(";")[0]! } });
    expect(await google.currentGoogleLogin(confirmedRequest)).toMatchObject({ subject, emailVerified: true, authenticatedAt: expect.any(Number), loginId: nonce });
    expect((await google.handleLogin(new Request(missingTime.callback, { headers: { Cookie: missingTime.cookie } })))!.status).toBe(400);
    for (const offset of [-3600, 3600]) {
      issuedAtOffset = offset;
      const invalid = await start();
      expect((await google.handleLogin(new Request(invalid.callback, { headers: { Cookie: invalid.cookie } })))!.status).toBe(403);
    }
    issuedAtOffset = 0; includeIssuedAt = false;
    const missingIssuedAt = await start();
    expect((await google.handleLogin(new Request(missingIssuedAt.callback, { headers: { Cookie: missingIssuedAt.cookie } })))!.status).toBe(403);
    includeIssuedAt = true;
    const legacy = createCloudflareGatewayOAuthIdentity(bindings, `${origin}/oauth/unidocs-cloudflare`);
    const startedLegacy = (await legacy.handleLogin(new Request(`${origin}/oauth/unidocs-cloudflare/login`)))!;
    const targetLegacy = new URL(startedLegacy.headers.get("Location")!);
    nonce = targetLegacy.searchParams.get("nonce")!; subject = "ordinary-user";
    const legacyResponse = (await legacy.handleLogin(new Request(`${origin}/oauth/unidocs-cloudflare/login/callback?code=legacy&state=${encodeURIComponent(targetLegacy.searchParams.get("state")!)}`, { headers: { Cookie: startedLegacy.headers.get("Set-Cookie")!.split(";")[0]! } })))!;
    const legacyRequest = new Request(`${origin}/admin/`, { headers: { Cookie: legacyResponse.headers.get("Set-Cookie")!.split(";")[0]! } });
    expect(await legacy.identity.currentUser(legacyRequest)).toMatchObject({ principalId: "ordinary-user" });
    expect(await google.currentGoogleLogin(legacyRequest)).toBeNull();
  } finally { globalThis.fetch = original; }
});