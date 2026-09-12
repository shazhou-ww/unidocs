import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { D1AdminMcpMembers } from "../../../packages/cloudflare-portal/src/mcp/members.ts";

test("MCP dispatcher isolates cookies and bounds bodies inside workerd", async () => {
  const built = await build({
    stdin: {
      contents: `import { dispatchAdminMcp } from './packages/cloudflare-portal/src/mcp/dispatcher.ts';
        export default { async fetch(request) {
          return await dispatchAdminMcp(request, {
            enabled: !new URL(request.url).searchParams.has('disabled'),
            publicOrigin: 'https://portal.test',
            handler: async sanitized => Response.json({
              cookie: sanitized.headers.get('cookie'),
              csrf: sanitized.headers.get('x-csrf-token'),
              authorization: sanitized.headers.get('authorization'),
              size: (await sanitized.arrayBuffer()).byteLength,
            }, { headers: { 'Set-Cookie': '__Host-unidocs_admin=must-not-escape' } }),
          }) ?? new Response('outside-mcp', { status: 404 });
        } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024",
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "portal-mcp-dispatch", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-08-18",
  }] }));
  try {
    const headers = {
      cookie: "__Host-unidocs_admin=private; __Host-unidocs_admin_mcp_oauth=state; __Host-unidocs_admin_mcp_consent=consent",
      "x-csrf-token": "private-csrf", authorization: "Bearer dedicated-mcp-token",
    };
    const response = await runtime.dispatchFetch("https://portal.test/mcp", { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cookie: null, csrf: null, authorization: "Bearer dedicated-mcp-token", size: 2 });
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const browser = await runtime.dispatchFetch("https://portal.test/oauth/admin-mcp/authorize", { headers });
    expect(await browser.json()).toMatchObject({ cookie: "__Host-unidocs_admin_mcp_oauth=state; __Host-unidocs_admin_mcp_consent=consent", csrf: null });
    expect(browser.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect((await runtime.dispatchFetch("https://portal.test/mcp?disabled")).status).toBe(404);
    for (const extra of [0, 1]) {
      const token = await runtime.dispatchFetch("https://portal.test/oauth/admin-mcp/token", { method: "POST", body: new Uint8Array(65_536 + extra) });
      expect(token.status).toBe(extra ? 413 : 200);
    }
    const foreign = await runtime.dispatchFetch("https://portal.test/mcp", { headers: { origin: "https://other.test" } });
    expect(foreign.status).toBe(403);
    expect(await (await runtime.dispatchFetch("https://portal.test/oauth/unidocs-cloudflare/token")).text()).toBe("outside-mcp");
  } finally {
    await runtime.dispose();
  }
});

describe("Admin MCP OAuth provider in workerd", () => {
  let runtime;
  let kv;
  let database;
  const origin = "https://portal.test";
  const resource = `${origin}/mcp`;
  const timestamp = 1_800_000_000;
  beforeAll(async () => {
    const built = await build({
      stdin: {
        contents: `import { createAdminMcpOAuth } from './packages/cloudflare-portal/src/mcp/oauth.ts';
          export default { async fetch(request, env, context) {
            const now = Number(await env.OAUTH_KV.get('fixture-time') ?? '${timestamp}');
            const identity = { issuer: 'https://accounts.google.com', subject: 'subject', email: 'admin@example.com', authenticatedAt: ${timestamp} };
            const provider = createAdminMcpOAuth({
              publicOrigin: '${origin}', allowedEmails: ['admin@example.com'], now: () => now,
              authorize: async (request, helpers) => {
                try {
                  const auth = await helpers.parseAuthRequest(request);
                  const result = await helpers.completeAuthorization({ request: auth, userId: 'member',
                    metadata: {}, scope: auth.scope, props: { memberId: 'member', identity, authorizedAt: now } });
                  return Response.redirect(result.redirectTo, 302);
                } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
              },
              api: async (request, grant) => Response.json({ memberId: grant.memberId, scopes: grant.scopes, clientId: grant.clientId, cookie: request.headers.get('cookie') }),
            });
            const failKvWrite = await env.OAUTH_KV.get('fixture-fail-kv-write');
            const oauthKv = failKvWrite ? new Proxy(env.OAUTH_KV, {
              get(target, property) {
                if (property === 'put') return async () => { throw new Error('private KV failure'); };
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }) : env.OAUTH_KV;
            const failAfterD1Commit = await env.OAUTH_KV.get('fixture-fail-after-d1-commit');
            const database = failAfterD1Commit ? {
              prepare(sql) {
                const statement = env.DB.prepare(sql);
                if (!sql.includes('portal_mcp_refresh_consumptions')) return statement;
                return { bind(...values) {
                  const bound = statement.bind(...values);
                  return { async run() { await bound.run(); throw new Error('private D1 acknowledgement lost'); } };
                } };
              },
            } : env.DB;
            return provider.fetch(request, { ...env, DB: database, OAUTH_KV: oauthKv }, context);
          } };`,
        resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "ts",
      },
      bundle: true, write: false, format: "esm", platform: "browser", target: "es2024", external: ["cloudflare:workers", "node:crypto"],
    });
    runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{
      name: "portal-mcp-oauth", modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-08-18",
      compatibilityFlags: ["nodejs_compat"], kvNamespaces: { OAUTH_KV: "portal-mcp-oauth-fixture" },
      d1Databases: { DB: "portal-mcp-refresh-fixture" },
    }] }));
    kv = await runtime.getKVNamespace("OAUTH_KV", "portal-mcp-oauth");
    database = await runtime.getD1Database("DB", "portal-mcp-oauth");
    const authMigration = await readFile(new URL("../../../packages/cloudflare-portal/migrations/0001_admin_auth.sql", import.meta.url), "utf8");
    await database.batch(authMigration.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => database.prepare(statement)));
    await database.prepare(`INSERT INTO portal_administrators (member_id, email, issuer, subject, added_by, created_at, updated_at)
      VALUES ('member', 'admin@example.com', 'https://accounts.google.com', 'subject', 'fixture', ?, ?)`)
      .bind(timestamp, timestamp).run();
    const migration = await readFile(new URL("../../../packages/cloudflare-portal/migrations/0009_mcp_refresh_consumption.sql", import.meta.url), "utf8");
    await database.batch(migration.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => database.prepare(statement)));
    const codeMigration = await readFile(new URL("../../../packages/cloudflare-portal/migrations/0010_mcp_code_consumption.sql", import.meta.url), "utf8");
    await database.batch(codeMigration.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => database.prepare(statement)));
  });
  afterAll(async () => { await runtime?.dispose(); });

  const register = metadata => runtime.dispatchFetch(`${origin}/oauth/admin-mcp/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Fixture MCP client", redirect_uris: ["http://127.0.0.1:43210/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...metadata }),
  });
  const token = (body, path = "token") => runtime.dispatchFetch(`${origin}/oauth/admin-mcp/${path}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString(),
  });
  const api = accessToken => runtime.dispatchFetch(resource, { headers: { authorization: `Bearer ${accessToken}`, cookie: "__Host-unidocs_admin=not-used" } });

  async function authorization(scope = "admin:read admin:content") {
    const registration = await register();
    expect(registration.status).toBe(201);
    const client = await registration.json();
    const verifier = randomBytes(32).toString("base64url");
    const params = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: "code", scope, resource,
      state: "fixture-state", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    const response = await runtime.dispatchFetch(`${origin}/oauth/admin-mcp/authorize?${new URLSearchParams(params)}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("location"));
    expect(redirect.searchParams.get("state")).toBe("fixture-state");
    expect(redirect.searchParams.get("iss")).toBe(origin);
    return { client, params, exchange: { client_id: client.client_id, redirect_uri: client.redirect_uris[0], grant_type: "authorization_code", code: redirect.searchParams.get("code"), code_verifier: verifier, resource } };
  }

  test("discovery advertises canonical resource, S256 and dedicated revocation", async () => {
    const challenge = await runtime.dispatchFetch(resource);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(challenge.headers.get("cache-control")).toBe("no-store");
    expect(await (await runtime.dispatchFetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json()).toMatchObject({ resource, authorization_servers: [origin], bearer_methods_supported: ["header"] });
    const metadata = await (await runtime.dispatchFetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    expect(metadata).toMatchObject({ issuer: origin, authorization_endpoint: `${origin}/oauth/admin-mcp/authorize`, token_endpoint: `${origin}/oauth/admin-mcp/token`, revocation_endpoint: `${origin}/oauth/admin-mcp/revoke`, code_challenge_methods_supported: ["S256"] });
    expect(metadata.scopes_supported).toEqual(["admin:read", "admin:content", "admin:publish", "admin:security"]);
    expect(metadata.response_types_supported).not.toContain("token");
    expect((await api("google-or-tenant-token")).status).toBe(401);
  });

  test("DCR allows only public clients with safe explicit redirect URIs", async () => {
    for (const metadata of [{ token_endpoint_auth_method: "client_secret_basic" }, { redirect_uris: ["javascript:alert(1)"] },
      { redirect_uris: ["http://remote.example/callback"] }, { redirect_uris: ["https://user:password@example.com/callback"] },
      { redirect_uris: ["https://example.com/callback#fragment"] }, { software_statement: "unverified" }]) {
      expect((await register(metadata)).status).toBe(400);
    }
  });

  test("PKCE, exact redirects and audience reject unsafe authorization requests", async () => {
    const { params } = await authorization();
    for (const change of [{ code_challenge_method: "plain" }, { code_challenge: "" }, { response_type: "token" }, { redirect_uri: "https://other.example" }, { resource: "https://other.example/mcp" }, { scope: "admin:unknown" }]) {
      const response = await runtime.dispatchFetch(`${origin}/oauth/admin-mcp/authorize?${new URLSearchParams({ ...params, ...change })}`, { redirect: "manual" });
      expect(response.status).toBe(400);
    }
  });

  test("tokens carry downscoped permissions and revocation works", async () => {
    const { exchange, client } = await authorization();
    expect((await token({ ...exchange, resource: "https://other.example/mcp" })).status).toBe(400);
    expect((await token({ ...exchange, code_verifier: randomBytes(32).toString("base64url") })).status).toBe(400);
    const issued = await token({ ...exchange, scope: "admin:read" });
    expect(issued.status).toBe(200);
    const tokens = await issued.json();
    expect(tokens.expires_in).toBe(900);
    expect(tokens.scope).toBe("admin:read");
    expect(await (await api(tokens.access_token)).json()).toEqual({ memberId: "member", clientId: client.client_id, scopes: ["admin:read"], cookie: null });
    const refresh = await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, scope: "admin:read", resource });
    expect(refresh.status).toBe(200);
    const next = await refresh.json();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await (await api(next.access_token)).json()).toMatchObject({ scopes: ["admin:read"] });
    const other = await (await register()).json();
    expect((await token({ grant_type: "refresh_token", client_id: other.client_id, refresh_token: next.refresh_token, resource })).status).toBe(400);
    expect((await token({ token: next.refresh_token, client_id: client.client_id, token_type_hint: "refresh_token" }, "revoke")).status).toBe(200);
    expect((await api(next.access_token)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: next.refresh_token, resource })).status).toBe(400);
  });

  test("removed members cannot use access tokens or refresh grants", async () => {
    const { exchange, client } = await authorization("admin:read");
    const tokens = await (await token(exchange)).json();
    expect((await api(tokens.access_token)).status).toBe(200);
    await database.prepare("UPDATE portal_administrators SET active = 0 WHERE member_id = 'member'").run();
    try {
      expect((await api(tokens.access_token)).status).toBe(401);
      expect((await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource })).status).toBe(400);
    } finally { await database.prepare("UPDATE portal_administrators SET active = 1 WHERE member_id = 'member'").run(); }
  });

  test("reusing a consumed authorization code revokes its grant", async () => {
    const { exchange } = await authorization("admin:read");
    const issued = await token(exchange);
    expect(issued.status).toBe(200);
    const tokens = await issued.json();
    expect((await api(tokens.access_token)).status).toBe(200);
    expect((await token(exchange)).status).toBe(400);
    expect((await api(tokens.access_token)).status).toBe(401);
  });

  test("current D1 email and identity binding govern access and refresh", async () => {
    const { request, tokens, hash } = await refreshFixture();
    for (const [issuer, subject, email] of [
      ["https://other.example", "subject", "admin@example.com"],
      ["https://accounts.google.com", "other-subject", "admin@example.com"],
      ["https://accounts.google.com", "subject", "outside-canary@example.com"],
      [null, null, "admin@example.com"],
    ]) {
      await database.prepare("UPDATE portal_administrators SET issuer = ?, subject = ?, email = ? WHERE member_id = 'member'")
        .bind(issuer, subject, email).run();
      try {
        expect((await api(tokens.access_token)).status).toBe(401);
        expect((await token(request)).status).toBe(400);
      } finally {
        await database.prepare("UPDATE portal_administrators SET issuer = 'https://accounts.google.com', subject = 'subject', email = 'admin@example.com' WHERE member_id = 'member'").run();
      }
    }
    expect(await database.prepare("SELECT token_hash FROM portal_mcp_refresh_consumptions WHERE token_hash = ?").bind(hash).first()).toBeNull();
    expect((await api(tokens.access_token)).status).toBe(200);
    expect((await token(request)).status).toBe(200);
  });

  test("reinviting the same Google identity under a new member ID never revives the old grant", async () => {
    const { request, tokens } = await refreshFixture();
    await database.prepare("UPDATE portal_administrators SET active = 0 WHERE member_id = 'member'").run();
    try {
      await database.prepare(`INSERT INTO portal_administrators (member_id, email, issuer, subject, added_by, created_at, updated_at)
        VALUES ('replacement', 'admin@example.com', 'https://accounts.google.com', 'subject', 'fixture', ?, ?)`)
        .bind(timestamp, timestamp).run();
      const members = new D1AdminMcpMembers(database);
      expect(await members.findById("member")).toBeNull();
      expect(await members.findByIdentity({ issuer: "https://accounts.google.com", subject: "subject" })).toMatchObject({ memberId: "replacement", active: true });
      expect((await api(tokens.access_token)).status).toBe(401);
      expect((await token(request)).status).toBe(400);
    } finally {
      await database.prepare("DELETE FROM portal_administrators WHERE member_id = 'replacement'").run();
      await database.prepare("UPDATE portal_administrators SET active = 1 WHERE member_id = 'member'").run();
    }
  });

  test("MCP identity lookup cannot bind invited emails or create browser sessions", async () => {
    const members = new D1AdminMcpMembers(database);
    await database.prepare(`INSERT INTO portal_administrators (member_id, email, added_by, created_at, updated_at)
      VALUES ('invited', 'invited@example.com', 'fixture', ?, ?)`).bind(timestamp, timestamp).run();
    try {
      expect(await members.findById("invited")).toBeNull();
      expect(await members.findByIdentity({ issuer: "https://accounts.google.com", subject: "invited-subject" })).toBeNull();
      expect(await members.findByIdentity({ issuer: "https://other.example", subject: "subject" })).toBeNull();
      expect(await members.findById("member")).toEqual({ memberId: "member", issuer: "https://accounts.google.com", subject: "subject", email: "admin@example.com", active: true });
      expect(await database.prepare("SELECT issuer, subject, revision FROM portal_administrators WHERE member_id = 'invited'").first()).toEqual({ issuer: null, subject: null, revision: 0 });
      for (const table of ["portal_sessions", "portal_session_families", "portal_admin_audit", "portal_auth_audit", "portal_bootstrap"]) {
        expect(await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count")).toBe(0);
      }
    } finally { await database.prepare("DELETE FROM portal_administrators WHERE member_id = 'invited'").run(); }
  });

  test("authorization codes expire after five minutes and grants after eight hours", async () => {
    const { exchange } = await authorization("admin:read");
    await kv.put("fixture-time", String(timestamp + 300));
    try {
      expect((await token(exchange)).status).toBe(400);
    } finally { await kv.delete("fixture-time"); }
    const authorized = await authorization("admin:read");
    const tokens = await (await token(authorized.exchange)).json();
    await kv.put("fixture-time", String(timestamp + 28_800));
    try {
      expect((await api(tokens.access_token)).status).toBe(401);
      expect((await token({ grant_type: "refresh_token", client_id: authorized.client.client_id, refresh_token: tokens.refresh_token, resource })).status).toBe(400);
    } finally { await kv.delete("fixture-time"); }
  });

  test("D1 rejects a previously consumed refresh token despite the provider retry window", async () => {
    const { exchange, client } = await authorization("admin:read");
    const issued = await token(exchange);
    expect(issued.status).toBe(200);
    const tokens = await issued.json();
    const request = { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource };
    expect((await token(request)).status).toBe(200);
    const replay = await token(request);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    const hash = createHash("sha256").update(tokens.refresh_token).digest("hex");
    expect(await database.prepare("SELECT * FROM portal_mcp_refresh_consumptions WHERE token_hash = ?").bind(hash).first()).toEqual({
      token_hash: hash, consumed_at: timestamp, expires_at: timestamp + 28_800,
    });
  });

  test("rejects duplicate parameters and cross-endpoint grant/revoke confusion", async () => {
    expect((await token({ token: "invalid", client_id: "invalid" })).status).toBe(400);
    expect((await token({ grant_type: "authorization_code", code: "invalid", client_id: "invalid" }, "revoke")).status).toBe(400);
    const response = await runtime.dispatchFetch(`${origin}/oauth/admin-mcp/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&grant_type=refresh_token",
    });
    expect(response.status).toBe(400);
    const { params } = await authorization();
    const authorize = await runtime.dispatchFetch(`${origin}/oauth/admin-mcp/authorize?${new URLSearchParams(params)}&scope=admin:security`, { redirect: "manual" });
    expect(authorize.status).toBe(400);
  });

  test("concurrent authorization code exchange issues tokens at most once", async () => {
    const { exchange } = await authorization("admin:read");
    const responses = await Promise.all(Array.from({ length: 8 }, () => token(exchange)));
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect(responses.filter(response => response.status === 400)).toHaveLength(7);
    const hash = createHash("sha256").update(exchange.code).digest("hex");
    expect(await database.prepare("SELECT * FROM portal_mcp_code_consumptions WHERE token_hash = ?").bind(hash).first()).toEqual({
      token_hash: hash, consumed_at: timestamp, expires_at: timestamp + 300,
    });
  });

  test("invalid PKCE, client, audience and missing membership do not consume a valid code", async () => {
    const { exchange } = await authorization("admin:read");
    const other = await (await register()).json();
    for (const change of [{ code_verifier: randomBytes(32).toString("base64url") }, { client_id: other.client_id }, { resource: "https://other.example/mcp" }]) {
      expect((await token({ ...exchange, ...change })).status).toBe(400);
    }
    await database.prepare("UPDATE portal_administrators SET active = 0 WHERE member_id = 'member'").run();
    try { expect((await token(exchange)).status).toBe(400); }
    finally { await database.prepare("UPDATE portal_administrators SET active = 1 WHERE member_id = 'member'").run(); }
    const hash = createHash("sha256").update(exchange.code).digest("hex");
    expect(await database.prepare("SELECT token_hash FROM portal_mcp_code_consumptions WHERE token_hash = ?").bind(hash).first()).toBeNull();
    expect((await token(exchange)).status).toBe(200);
  });

  test("code consumption survives stale KV reads and failed token writes", async () => {
    const { exchange } = await authorization("admin:read");
    const grantKey = `grant:${exchange.code.split(":").slice(0, 2).join(":")}`;
    const before = await kv.get(grantKey);
    await kv.put("fixture-fail-kv-write", "true");
    try { expect((await token(exchange)).status).toBe(503); }
    finally { await kv.delete("fixture-fail-kv-write"); }
    await kv.put(grantKey, before);
    const replay = await token(exchange);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    const hash = createHash("sha256").update(exchange.code).digest("hex");
    expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_mcp_code_consumptions WHERE token_hash = ?").bind(hash).first("count")).toBe(1);
  });

  async function refreshFixture() {
    const { exchange, client } = await authorization("admin:read");
    const issued = await token(exchange);
    expect(issued.status).toBe(200);
    const tokens = await issued.json();
    return { tokens, hash: createHash("sha256").update(tokens.refresh_token).digest("hex"),
      request: { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource } };
  }

  test("concurrent refresh attempts admit exactly one winner and its successor remains usable", async () => {
    const { request, hash } = await refreshFixture();
    const responses = await Promise.all(Array.from({ length: 8 }, () => token(request)));
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect(responses.filter(response => response.status === 400)).toHaveLength(7);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_mcp_refresh_consumptions WHERE token_hash = ?").bind(hash).first("count")).toBe(1);
    const winner = await responses.find(response => response.status === 200).json();
    expect((await api(winner.access_token)).status).toBe(200);
    expect((await token({ ...request, refresh_token: winner.refresh_token })).status).toBe(200);
    expect((await token(request)).status).toBe(400);
  });

  test("wrong clients, invalid tokens and removed members cannot burn a refresh token", async () => {
    const { request, hash } = await refreshFixture();
    const other = await (await register()).json();
    expect((await token({ ...request, client_id: other.client_id })).status).toBe(400);
    expect((await token({ ...request, refresh_token: "invalid-token" })).status).toBe(400);
    await database.prepare("UPDATE portal_administrators SET active = 0 WHERE member_id = 'member'").run();
    try { expect((await token(request)).status).toBe(400); }
    finally { await database.prepare("UPDATE portal_administrators SET active = 1 WHERE member_id = 'member'").run(); }
    expect(await database.prepare("SELECT token_hash FROM portal_mcp_refresh_consumptions WHERE token_hash = ?").bind(hash).first()).toBeNull();
    expect((await token(request)).status).toBe(200);
  });

  test("D1 failure denies issuance without silently bypassing consumption", async () => {
    const { request, hash } = await refreshFixture();
    await database.prepare("CREATE TRIGGER reject_refresh BEFORE INSERT ON portal_mcp_refresh_consumptions BEGIN SELECT RAISE(ABORT, 'private D1 failure'); END").run();
    try {
      const response = await token(request);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "temporarily_unavailable", error_description: "Admin MCP authorization request rejected" });
      expect(await database.prepare("SELECT token_hash FROM portal_mcp_refresh_consumptions WHERE token_hash = ?").bind(hash).first()).toBeNull();
    } finally { await database.prepare("DROP TRIGGER reject_refresh").run(); }
    expect((await token(request)).status).toBe(200);
  });

  test("KV failure after D1 consumption never restores the old refresh token", async () => {
    const { request, hash } = await refreshFixture();
    await kv.put("fixture-fail-kv-write", "true");
    try {
      const response = await token(request);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private KV failure");
    } finally { await kv.delete("fixture-fail-kv-write"); }
    expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_mcp_refresh_consumptions WHERE token_hash = ?").bind(hash).first("count")).toBe(1);
    expect((await token(request)).status).toBe(400);
  });

  test("an uncertain D1 commit is not rolled back or retried as an unused token", async () => {
    const { request, hash } = await refreshFixture();
    await kv.put("fixture-fail-after-d1-commit", "true");
    try {
      const response = await token(request);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
    } finally { await kv.delete("fixture-fail-after-d1-commit"); }
    expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_mcp_refresh_consumptions WHERE token_hash = ?").bind(hash).first("count")).toBe(1);
    expect((await token(request)).status).toBe(400);
  });

  test("a lost success response does not authorize a retry and independent grants do not share request state", async () => {
    const first = await refreshFixture();
    const second = await refreshFixture();
    const responses = await Promise.all([token(first.request), token(second.request)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    await Promise.all(responses.map(response => response.body.cancel()));
    expect((await token(first.request)).status).toBe(400);
    expect((await token(second.request)).status).toBe(400);
    for (const { hash } of [first, second]) {
      expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_mcp_refresh_consumptions WHERE token_hash = ?").bind(hash).first("count")).toBe(1);
    }
  });
});