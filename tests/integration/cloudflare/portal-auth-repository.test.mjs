import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { D1PortalAuthRepository } from "../../../packages/cloudflare-portal/src/auth-repository.ts";
import { createPortalBff } from "../../../packages/cloudflare-portal/src/bff.ts";
import { portalGoogleConfigFromGateway } from "../../../packages/cloudflare-portal/src/google-config.ts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let miniflare;
let database;
let repository;
const now = 1_800_000_000;
const identity = { issuer: "https://accounts.google.com", subject: "first", email: "first@example.com", authenticatedAt: now };
beforeEach(async () => {
  miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "portal-auth-repository", modules: true, script: "export default { fetch() { return new Response('test'); } };",
    compatibilityDate: "2026-08-18", d1Databases: { DB: `portal-auth-${crypto.randomUUID()}` },
  }] }));
  database = await miniflare.getD1Database("DB", "portal-auth-repository");
  const migration = await readFile(new URL("../../../packages/cloudflare-portal/migrations/0001_admin_auth.sql", import.meta.url), "utf8");
  await database.batch(migration.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => database.prepare(statement)));
  repository = new D1PortalAuthRepository(database, () => now);
});
afterEach(async () => { await miniflare?.dispose(); });

test("auth migration initializes independent tables with foreign keys and expiry bounds", async () => {
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_administrators").first("count")).toBe(0);
  await expect(database.prepare("INSERT INTO portal_bootstrap VALUES (1, 'missing')").run()).rejects.toThrow();
  await expect(database.prepare("INSERT INTO portal_login_transactions VALUES ('state', 'browser', 'verifier', 'nonce', '/admin/', 1000, 1601)").run()).rejects.toThrow();
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_mutation_guard").first("count")).toBe(0);
});

test("repository persists browser-bound state and consumes once under concurrency", async () => {
  const transaction = { stateHash: "state", browserHash: "browser", verifier: "verifier", nonce: "nonce", returnTo: "/admin/", createdAt: now, expiresAt: now + 600 };
  await repository.put(transaction);
  expect(await repository.take("state", "wrong", now)).toBeNull();
  expect(await repository.take("state", "browser", now + 600)).toBeNull();
  const results = await Promise.all([repository.take("state", "browser", now), repository.take("state", "browser", now)]);
  expect(results.filter(Boolean)).toEqual([transaction]);
});

test("bootstrap creates member, session and audits atomically with no raw secrets in D1", async () => {
  const issued = await repository.completeLogin(identity, identity.email, "request-first");
  expect(await repository.findSession(issued.session.sessionHash)).toEqual(issued.session);
  expect(await repository.findMemberByIdentity(identity)).toMatchObject({ memberId: issued.memberId });
  const stored = await database.prepare("SELECT * FROM portal_sessions").all();
  expect(JSON.stringify(stored.results)).not.toContain(issued.token);
  expect(JSON.stringify(stored.results)).not.toContain(issued.csrfToken);
  expect(await database.prepare("SELECT action FROM portal_admin_audit").first("action")).toBe("administrator.bootstrap");
  expect(await database.prepare("SELECT request_id FROM portal_auth_audit").first("request_id")).toBe("request-first");
});

test("uninvited identities cannot bootstrap or replace the configured initial administrator", async () => {
  await expect(repository.completeLogin(identity, "other@example.com", "denied")).rejects.toThrow();
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_administrators").first("count")).toBe(0);
  await repository.completeLogin(identity, identity.email, "first");
  await expect(repository.completeLogin({ ...identity, subject: "other" }, identity.email, "replacement")).rejects.toThrow();
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_administrators").first("count")).toBe(1);
});

test("relogin invalidates old sessions and logout revokes the current family", async () => {
  const first = await repository.completeLogin(identity, identity.email, "first");
  const next = await repository.completeLogin(identity, null, "next");
  expect(next.memberId).toBe(first.memberId);
  expect(await repository.findSession(first.session.sessionHash)).toBeNull();
  expect(await repository.findSession(next.session.sessionHash)).not.toBeNull();
  await repository.revokeSession(next.session.sessionHash, next.memberId, "logout");
  expect(await repository.findSession(next.session.sessionHash)).toBeNull();
});

test("invitation binding persists once and removed members immediately lose access", async () => {
  await repository.completeLogin(identity, identity.email, "first");
  await database.prepare(`INSERT INTO portal_administrators (member_id,email,added_by,created_at,updated_at) VALUES ('invited','invited@example.com','first',?,?)`).bind(now, now).run();
  const invited = { ...identity, subject: "invited-subject", email: "invited@example.com" };
  const issued = await repository.completeLogin(invited, null, "bind");
  expect(issued.memberId).toBe("invited");
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_admin_audit WHERE action = 'administrator.bound'").first("count")).toBe(1);
  await database.prepare("UPDATE portal_administrators SET active = 0 WHERE member_id = 'invited'").run();
  expect(await repository.findSession(issued.session.sessionHash)).toBeNull();
  expect(await repository.findMemberByIdentity(invited)).toBeNull();
  await expect(repository.completeLogin(invited, null, "removed")).rejects.toThrow();
});

test("session audit failure rolls back bootstrap completely", async () => {
  await database.prepare("CREATE TRIGGER reject_auth_audit BEFORE INSERT ON portal_auth_audit BEGIN SELECT RAISE(ABORT, 'injected failure'); END").run();
  await expect(repository.completeLogin(identity, identity.email, "failure")).rejects.toThrow();
  for (const table of ["portal_administrators", "portal_bootstrap", "portal_admin_audit", "portal_sessions", "portal_session_families"]) {
    expect(await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count")).toBe(0);
  }
});

test("concurrent initial logins leave one bootstrap and at most one live session", async () => {
  const results = await Promise.allSettled([repository.completeLogin(identity, identity.email, "left"), repository.completeLogin(identity, identity.email, "right")]);
  expect(results.some(result => result.status === "fulfilled")).toBe(true);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_bootstrap").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_sessions").first("count")).toBe(1);
});

test("BFF completes Google callback into D1 session, reads identity and enforces CSRF logout", async () => {
  const config = portalGoogleConfigFromGateway({ GATEWAY_OIDC_CLIENT_ID: "gateway-client", GATEWAY_OIDC_CLIENT_SECRET: "fixture-secret" }, "https://portal.test");
  const keys = await generateKeyPair("RS256");
  let nonce;
  const googleFetch = async (input) => {
    const url = String(input);
    if (url.endsWith("openid-configuration")) return Response.json({ issuer: config.issuer, authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs", code_challenge_methods_supported: ["S256"] });
    if (url.endsWith("/certs")) return Response.json({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256", use: "sig" }] });
    const token = await new SignJWT({ iss: config.issuer, aud: config.clientId, sub: identity.subject, email: identity.email, email_verified: true, auth_time: now, iat: now, exp: now + 600, nonce }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(keys.privateKey);
    return Response.json({ access_token: "discarded", token_type: "Bearer", id_token: token });
  };
  const handle = createPortalBff(config, repository, { bootstrapEmail: identity.email, now: () => now, googleFetch });
  const start = await handle(new Request("https://portal.test/admin/auth/login"));
  expect(start.status).toBe(303);
  const authorization = new URL(start.headers.get("location"));
  nonce = authorization.searchParams.get("nonce");
  const callback = new Request(`https://portal.test/admin/auth/callback?code=test&state=${authorization.searchParams.get("state")}`, { headers: { cookie: start.headers.getSetCookie()[0].split(";")[0] } });
  const completed = await handle(callback);
  expect(completed.status).toBe(303);
  expect(completed.headers.get("location")).toBe("https://portal.test/admin/");
  const cookies = completed.headers.getSetCookie();
  const sessionCookie = cookies.find(cookie => cookie.startsWith("__Host-unidocs_admin="));
  const csrfCookie = cookies.find(cookie => cookie.startsWith("__Host-unidocs_admin_csrf="));
  expect(sessionCookie).toContain("HttpOnly");
  expect(csrfCookie).not.toContain("HttpOnly");
  const cookie = sessionCookie.split(";")[0];
  const csrf = csrfCookie.split(";")[0].split("=")[1];
  const session = await handle(new Request("https://portal.test/admin/auth/session", { headers: { cookie } }));
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ email: identity.email, transport: "session" });
  expect(session.headers.get("cache-control")).toBe("no-store");
  expect((await handle(callback)).status).toBe(401);
  expect((await handle(new Request("https://portal.test/admin/auth/logout", { method: "POST", headers: { cookie, origin: config.origin } }))).status).toBe(403);
  expect((await handle(new Request("https://portal.test/admin/auth/logout", { method: "POST", headers: { cookie, origin: config.origin, "x-csrf-token": csrf } }))).status).toBe(204);
  expect((await handle(new Request("https://portal.test/admin/auth/session", { headers: { cookie } }))).status).toBe(401);
  expect((await handle(new Request("https://portal.test/admin/auth/logout"))).status).toBe(405);
  expect((await handle(new Request("https://portal.test/admin/api/v1/document-types"))).status).toBe(404);
});

test("failed relogin leaves the original session usable and failed logout is atomic", async () => {
  const issued = await repository.completeLogin(identity, identity.email, "first");
  await database.prepare("CREATE TRIGGER reject_auth_audit BEFORE INSERT ON portal_auth_audit BEGIN SELECT RAISE(ABORT, 'injected failure'); END").run();
  await expect(repository.completeLogin(identity, null, "failed-relogin")).rejects.toThrow();
  expect(await repository.findSession(issued.session.sessionHash)).toEqual(issued.session);
  await expect(repository.revokeSession(issued.session.sessionHash, issued.memberId, "failed-logout")).rejects.toThrow();
  expect(await repository.findSession(issued.session.sessionHash)).toEqual(issued.session);
});

test("login proof predating an invitation cannot bind it", async () => {
  await repository.completeLogin(identity, identity.email, "first");
  await database.prepare(`INSERT INTO portal_administrators (member_id,email,added_by,created_at,updated_at) VALUES ('invited','invited@example.com','first',?,?)`).bind(now, now).run();
  await expect(repository.completeLogin({ ...identity, subject: "invited", email: "invited@example.com", authenticatedAt: now - 1 }, null, "stale-proof")).rejects.toMatchObject({ code: "forbidden" });
  expect(await database.prepare("SELECT subject FROM portal_administrators WHERE member_id = 'invited'").first("subject")).toBeNull();
});

test("BFF and repository run together inside workerd across HTTP requests", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const fixture = { privateKey: await exportJWK(keys.privateKey), publicKey: await exportJWK(keys.publicKey) };
  const built = await build({
    stdin: {
      contents: `import { createPortalBff } from './packages/cloudflare-portal/src/bff.ts';
        import { D1PortalAuthRepository } from './packages/cloudflare-portal/src/auth-repository.ts';
        import { portalGoogleConfigFromGateway } from './packages/cloudflare-portal/src/google-config.ts';
        import { importJWK, SignJWT } from 'jose';
        export default { async fetch(request, env) {
          const config = portalGoogleConfigFromGateway({ GATEWAY_OIDC_CLIENT_ID: 'gateway-client', GATEWAY_OIDC_CLIENT_SECRET: 'test-secret' }, 'https://portal.test');
          const now = Math.floor(Date.now() / 1000);
          const repository = new D1PortalAuthRepository(env.DB, () => now);
          const googleFetch = async (input) => {
            const url = String(input);
            if (url.endsWith('openid-configuration')) return Response.json({ issuer: config.issuer,
              authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth', token_endpoint: 'https://oauth2.googleapis.com/token',
              jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs', code_challenge_methods_supported: ['S256'] });
            if (url.endsWith('/certs')) return Response.json({ keys: [{ ...env.FIXTURE.publicKey, kid: 'test', alg: 'RS256', use: 'sig' }] });
            const key = await importJWK(env.FIXTURE.privateKey, 'RS256');
            const token = await new SignJWT({ iss: config.issuer, aud: config.clientId, sub: 'first', email: 'first@example.com', email_verified: true,
              auth_time: now, iat: now, exp: now + 600, nonce: env.FIXTURE.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key);
            return Response.json({ token_type: 'Bearer', access_token: 'discarded', id_token: token });
          };
          return createPortalBff(config, repository, { now: () => now, bootstrapEmail: 'first@example.com', googleFetch })(request);
        } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024", external: ["node:crypto"],
  });
  const options = nonce => convertV4MiniflareOptions({ workers: [{ name: "portal-bff-runtime", modules: true,
    script: built.outputFiles[0].text, compatibilityDate: "2026-08-18", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "portal-bff-runtime-db" }, bindings: { FIXTURE: { ...fixture, nonce } },
  }] });
  const runtime = new Miniflare(options(""));
  try {
    const db = await runtime.getD1Database("DB", "portal-bff-runtime");
    const migration = await readFile(new URL("../../../packages/cloudflare-portal/migrations/0001_admin_auth.sql", import.meta.url), "utf8");
    await db.batch(migration.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
    const start = await runtime.dispatchFetch("https://portal.test/admin/auth/login", { redirect: "manual" });
    expect(start.status).toBe(303);
    const target = new URL(start.headers.get("location"));
    await runtime.setOptions(options(target.searchParams.get("nonce")));
    const completed = await runtime.dispatchFetch(`https://portal.test/admin/auth/callback?code=test&state=${target.searchParams.get("state")}`, {
      redirect: "manual",
      headers: { cookie: start.headers.getSetCookie()[0].split(";")[0] },
    });
    expect(completed.status).toBe(303);
    const cookies = completed.headers.getSetCookie();
    const cookie = cookies.find(value => value.startsWith("__Host-unidocs_admin=")).split(";")[0];
    const csrf = cookies.find(value => value.startsWith("__Host-unidocs_admin_csrf=")).split(";")[0].split("=")[1];
    const session = await runtime.dispatchFetch("https://portal.test/admin/auth/session", { headers: { cookie } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ email: "first@example.com", transport: "session" });
    expect((await runtime.dispatchFetch("https://portal.test/admin/auth/logout", { method: "POST", headers: { cookie, origin: "https://portal.test", "x-csrf-token": csrf } })).status).toBe(204);
    expect((await runtime.dispatchFetch("https://portal.test/admin/auth/session", { headers: { cookie } })).status).toBe(401);
  } finally { await runtime.dispose(); }
}, 30_000);