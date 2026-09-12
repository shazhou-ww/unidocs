import { beforeAll, describe, expect, test, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { AdminAccessError, type AdminContext } from "@unidocs/portal-service";
import { auditAttribution } from "../src/audit-attribution.js";
import { ADMIN_COOKIE, SESSION_TTL_SECONDS, clearedAdminCookie, createAdminAuthenticator, createAdminSession, hashSessionSecret } from "../src/index.js";

const now = 1_800_000_000;
const origin = "https://admin.example.com";
const audience = "dedicated-admin-client";
const identity = { issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", authenticatedAt: now };
const member = { memberId: "member", issuer: identity.issuer, subject: identity.subject, active: true };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let resolveKeys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  resolveKeys = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "admin-key", alg: "RS256", use: "sig" }] });
});

async function bearer(overrides: JWTPayload = {}) {
  return new SignJWT({ iss: identity.issuer, sub: identity.subject, aud: audience, iat: now, exp: now + 3_600, auth_time: now, email: identity.email, email_verified: true, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "admin-key" }).sign(keys.privateKey);
}

async function setup() {
  const issued = await createAdminSession(member, identity, now);
  const ports = {
    now: () => now,
    keys: resolveKeys,
    findSession: vi.fn(async (hash: string) => hash === issued.session.sessionHash ? issued.session : null),
    findMemberById: vi.fn(async () => member),
    findMemberByIdentity: vi.fn(async () => member),
  };
  const authenticate = createAdminAuthenticator({ origin, audience }, ports);
  const request = (headers: Record<string, string> = {}, method = "POST", url = origin) => new Request(url, {
    method,
    headers: { cookie: `${ADMIN_COOKIE}=${issued.token}`, origin, "x-csrf-token": issued.csrfToken, ...headers },
  });
  return { issued, ports, authenticate, request };
}

describe("Cloudflare administrator authentication", () => {
  test("audit attribution defaults legacy callers and rejects malformed MCP attribution", () => {
    const context: AdminContext = { memberId: "member", identity, transport: "bearer" };
    const caller = { channel: "mcp" as const, oauthClientHandle: "a".repeat(64), toolName: "create_document_type" };
    expect(auditAttribution(context)).toEqual(["admin-webui", null, null]);
    expect(auditAttribution({ ...context, caller: { channel: "admin-webui" } })).toEqual(["admin-webui", null, null]);
    expect(auditAttribution({ ...context, caller })).toEqual(["mcp", "a".repeat(64), "create_document_type"]);
    for (const invalid of [
      { ...context, transport: "session" as const, caller },
      { ...context, caller: { ...caller, oauthClientHandle: "raw-client-id" } },
      { ...context, caller: { ...caller, toolName: "constructor" } },
      { ...context, caller: { ...caller, toolName: "unknown_tool" } },
    ]) expect(() => auditAttribution(invalid)).toThrow(AdminAccessError);
  });

  test("issues independent random secrets, stores only hashes and sets host-only secure cookies", async () => {
    const { issued } = await setup();
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.csrfToken).not.toBe(issued.token);
    expect(JSON.stringify(issued.session)).not.toContain(issued.token);
    expect(JSON.stringify(issued.session)).not.toContain(issued.csrfToken);
    expect(issued.session.sessionHash).toBe(await hashSessionSecret(issued.token));
    expect(issued.session.expiresAt).toBe(now + SESSION_TTL_SECONDS);
    expect(issued.cookie).toBe(`${ADMIN_COOKIE}=${issued.token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800`);
    expect(clearedAdminCookie()).toBe(`${ADMIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    expect((await createAdminSession(member, identity, now)).token).not.toBe(issued.token);
  });

  test("valid Bearer bypasses cookies and CSRF but still requires a bound member", async () => {
    const { ports, authenticate } = await setup();
    const request = new Request(origin, { method: "POST", headers: { authorization: `Bearer ${await bearer()}`, cookie: "broken" } });
    await expect(authenticate(request)).resolves.toMatchObject({ memberId: "member", transport: "bearer" });
    expect(ports.findSession).not.toHaveBeenCalled();
    ports.findMemberByIdentity.mockResolvedValue({ ...member, active: false });
    await expect(authenticate(request)).rejects.toMatchObject({ code: "forbidden" });
  });

  test.each(["Bearer broken", "Bearer", "Basic dGVzdA==", ""])('never falls back to cookie for authorization %j', async authorization => {
    const { ports, authenticate, request } = await setup();
    await expect(authenticate(request({ authorization }))).rejects.toMatchObject({ code: "unauthorized" });
    expect(ports.findSession).not.toHaveBeenCalled();
  });

  test.each([
    { iss: "https://attacker.example" }, { aud: "other-client" }, { exp: now - 31 },
    { iat: now + 31 }, { iat: now - 3_631 }, { auth_time: now + 31 },
    { email_verified: false }, { azp: "other-client" }, { aud: [audience, "other-client"] },
    { auth_time: undefined }, { exp: undefined }, { nbf: now + 31 },
    // Proves a loopback-looking issuer is rejected end-to-end — the value a
    // future local-dev change might plausibly add to the jwtVerify allowlist
    // at auth.ts:81 by mistake. It does not isolate that allowlist alone:
    // @unidocs/portal-service's readGoogleIdentity enforces the identical
    // literal independently, so this case stays green even if the allowlist
    // itself is loosened (verified by mutation testing — see the report).
    { iss: "http://127.0.0.1:8793" },
  ])("rejects signed tokens with invalid claims %# without cookie fallback", async overrides => {
    const { ports, authenticate, request } = await setup();
    await expect(authenticate(request({ authorization: `Bearer ${await bearer(overrides)}` }))).rejects.toMatchObject({ code: "unauthorized" });
    expect(ports.findSession).not.toHaveBeenCalled();
  });

  test("rejects a valid-looking token signed by an untrusted key", async () => {
    const { ports, authenticate, request } = await setup();
    const attacker = await generateKeyPair("RS256");
    const token = await new SignJWT({ iss: identity.issuer, sub: identity.subject, aud: audience, iat: now, exp: now + 600, auth_time: now, email: identity.email, email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "admin-key" }).sign(attacker.privateKey);
    await expect(authenticate(request({ authorization: `Bearer ${token}` }))).rejects.toThrow(AdminAccessError);
    expect(ports.findSession).not.toHaveBeenCalled();
  });

  test("cookie reads need no CSRF and mutations require both origin and matching CSRF", async () => {
    const { authenticate, request } = await setup();
    await expect(authenticate(request({}, "POST"))).resolves.toMatchObject({ transport: "session", caller: { channel: "admin-webui" } });
    await expect(authenticate(request({ "x-csrf-token": "", origin: "" }, "GET"))).resolves.toMatchObject({ transport: "session" });
    const invalidHeaders: Record<string, string>[] = [{ origin: "https://evil.example" }, { origin: "null" }, { origin: "" }, { "x-csrf-token": "" }, { "x-csrf-token": "a".repeat(43) }, { "sec-fetch-site": "cross-site" }];
    for (const headers of invalidHeaders) {
      await expect(authenticate(request(headers))).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(authenticate(request({}, "POST", "https://other.example"))).rejects.toMatchObject({ code: "forbidden" });
  });

  test("missing, malformed, duplicated and revoked session cookies fail closed", async () => {
    const { issued, authenticate, request } = await setup();
    for (const cookie of ["", `${ADMIN_COOKIE}=bad`, `${ADMIN_COOKIE}=${"a".repeat(43)}`, `${ADMIN_COOKIE}=${issued.token}; ${ADMIN_COOKIE}=${issued.token}`]) {
      await expect(authenticate(request({ cookie }))).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  test("expiration, revocation and removed membership are checked on every request", async () => {
    const { issued, ports, authenticate, request } = await setup();
    ports.now = () => issued.session.expiresAt - 1;
    await expect(authenticate(request())).resolves.toMatchObject({ memberId: "member" });
    ports.now = () => issued.session.expiresAt;
    await expect(authenticate(request())).rejects.toMatchObject({ code: "unauthorized" });
    ports.now = () => now;
    ports.findSession.mockResolvedValue(null);
    await expect(authenticate(request())).rejects.toMatchObject({ code: "unauthorized" });
    ports.findSession.mockResolvedValue(issued.session);
    ports.findMemberById.mockResolvedValue({ ...member, active: false });
    await expect(authenticate(request())).rejects.toMatchObject({ code: "forbidden" });
  });

  test("rejects session lifetime extension and mismatched principal lookup", async () => {
    const { issued, ports, authenticate, request } = await setup();
    ports.findSession.mockResolvedValue({ ...issued.session, expiresAt: now + SESSION_TTL_SECONDS + 1 });
    await expect(authenticate(request())).rejects.toMatchObject({ code: "unauthorized" });
    ports.findSession.mockResolvedValue(issued.session);
    ports.findMemberById.mockResolvedValue({ ...member, memberId: "replacement" });
    await expect(authenticate(request())).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("Administrator auth configuration", () => {
  const configPorts = { now: () => now, findSession: async () => null, findMemberById: async () => null, findMemberByIdentity: async () => null };

  // createAdminAuthenticator has its own copy of the origin guard
  // (independent of portalGoogleConfigFromGateway) — this is what let a
  // config built for local development still get refused here even after
  // google-config.ts's own check was relaxed.
  test("accepts a loopback origin for local development", () => {
    expect(() => createAdminAuthenticator({ origin: "http://127.0.0.1:8795", audience }, configPorts)).not.toThrow();
    expect(() => createAdminAuthenticator({ origin: "http://localhost:8795", audience }, configPorts)).not.toThrow();
  });

  test.each(["http://admin.example.com", "http://127.0.0.1.evil.test:8795"])("refuses a non-loopback http origin %s", authOrigin => {
    expect(() => createAdminAuthenticator({ origin: authOrigin, audience }, configPorts)).toThrow("Invalid administrator auth configuration");
  });
});