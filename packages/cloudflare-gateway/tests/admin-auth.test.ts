import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { AdminDirectory } from "@unidocs/gateway-common";
import { SqliteAdminDirectoryStore, type AdminSqliteStorage } from "../src/admin-directory-sqlite.js";
import { SqliteAdminSessionStore } from "../src/admin-session-store.js";
import { createAdminAuth } from "../src/admin-auth.js";
import { createFailClosedGatewayOAuthIdentity, type VerifiedGoogleLogin } from "../src/oauth-identity.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
async function setup() {
  const database = new DatabaseSync(":memory:"); databases.push(database);
  let timestamp = Date.now();
  const storage: AdminSqliteStorage = {
    sql: { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings); return { toArray: () => rows }; } },
    transactionSync(callback) { database.exec("BEGIN IMMEDIATE"); try { const result = callback(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
  const directory = new AdminDirectory(new SqliteAdminDirectoryStore(storage), undefined, () => new Date(timestamp).toISOString());
  await directory.bootstrap("shazhou.ww@gmail.com");
  let proof: VerifiedGoogleLogin | null = { issuer: "https://accounts.google.com", subject: "google-self", email: "shazhou.ww@gmail.com", emailVerified: true, loginId: "login-original", authenticatedAt: timestamp, expiresAt: timestamp + 3600_000 };
  const sessions = new SqliteAdminSessionStore(storage);
  const google = { ...createFailClosedGatewayOAuthIdentity(), currentGoogleLogin: async () => proof };
  const handler = createAdminAuth({ directory, sessions, google, origin: "https://app.test", now: () => timestamp });
  const send = (path: string, init?: RequestInit) => handler(new Request(`https://app.test${path}`, init));
  const login = async () => {
    const response = (await send("/admin/auth/session", { method: "POST", headers: { Origin: "https://app.test", "X-UniDocs-Admin": "1" } }))!;
    return { response, cookie: response.headers.get("Set-Cookie")?.split(";")[0] ?? "", body: await response.json() as { data: { csrfToken: string; expiresAt: number } } };
  };
  return { directory, database, sessions, send, login, proof: proof!, setProof: (value: VerifiedGoogleLogin | null) => { proof = value; }, advance: (ms: number) => { timestamp += ms; } };
}

it("requires trusted shared Google identity and same-origin session creation", async () => {
  const fixture = await setup();
  expect((await fixture.send("/admin/auth/session", { method: "POST" }))!.status).toBe(403);
  fixture.setProof(null);
  expect((await fixture.login()).response.status).toBe(401);
  fixture.setProof({ ...fixture.proof, email: "outsider@gmail.com", subject: "other" });
  expect((await fixture.login()).response.status).toBe(403);
  fixture.setProof(fixture.proof);
  const result = await fixture.login();
  expect(result.response.status).toBe(201);
  expect(result.cookie).toContain("__Host-unidocs_admin=");
  expect(result.response.headers.get("Set-Cookie")).toContain("Secure; HttpOnly; SameSite=Strict");
  const rows = fixture.database.prepare("SELECT * FROM unidocs_admin_sessions").all();
  expect(JSON.stringify(rows)).not.toContain(result.cookie.split("=")[1]);
  expect((await fixture.send("/admin/api/v1/administrators", { headers: { Cookie: result.cookie } }))!.status).toBe(200);
});

it("logs out without clearing Google cookies and rejects replayed management cookies", async () => {
  const fixture = await setup(); const result = await fixture.login();
  expect((await fixture.send("/admin/api/v1/session/logout", { method: "POST", headers: { Origin: "https://evil.test", Cookie: result.cookie } }))!.status).toBe(403);
  const response = (await fixture.send("/admin/api/v1/session/logout", { method: "POST", headers: { Origin: "https://app.test", Cookie: result.cookie, "X-CSRF-Token": result.body.data.csrfToken } }))!;
  expect(response.status).toBe(204);
  expect(response.headers.get("Set-Cookie")).not.toContain("gw_sess");
  expect((await fixture.send("/admin/api/v1/administrators", { headers: { Cookie: result.cookie } }))!.status).toBe(401);
});

it("binds sessions to the shared Google login and enforces idle expiry", async () => {
  const fixture = await setup(); const result = await fixture.login();
  fixture.setProof({ ...fixture.proof, loginId: "switched-google-login" });
  expect((await fixture.send("/admin/api/v1/session", { headers: { Cookie: result.cookie } }))!.status).toBe(401);
  fixture.setProof(fixture.proof);
  fixture.advance(30 * 60_000);
  expect((await fixture.send("/admin/api/v1/session", { headers: { Cookie: result.cookie } }))!.status).toBe(401);
});

it("consumes login state only once across store instances", async () => {
  const fixture = await setup();
  await fixture.sessions.register("nonce", Date.now() + 600_000);
  expect(await Promise.all([fixture.sessions.consume("nonce", Date.now()), fixture.sessions.consume("nonce", Date.now())])).toEqual([true, false]);
  await fixture.sessions.register("expired", Date.now() - 1);
  expect(await fixture.sessions.consume("expired", Date.now())).toBe(false);
});

it("does not reset recent Google authentication time when issuing a management session", async () => {
  const fixture = await setup();
  fixture.advance(16 * 60_000);
  const result = await fixture.login();
  expect(result.response.status).toBe(201);
  const response = await fixture.send("/admin/api/v1/administrators", { method: "POST", headers: { Origin: "https://app.test", Cookie: result.cookie, "X-CSRF-Token": result.body.data.csrfToken, "Content-Type": "application/json", "Idempotency-Key": "add" }, body: JSON.stringify({ email: "other@gmail.com" }) });
  expect(response!.status).toBe(403);
  expect(await response!.json()).toMatchObject({ error: { code: "reauthentication_required" } });
});