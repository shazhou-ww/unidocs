import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { AdminDirectory, createAdminHandler, administratorEtag, type AdminBrowserSession } from "@unidocs/gateway-common";
import { SqliteAdminDirectoryStore } from "../src/admin-directory-sqlite.js";

const databases: DatabaseSync[] = [];
const origin = "https://admin.test";
const timestamp = 1_800_000_000_000;
async function setup() {
  const database = new DatabaseSync(":memory:"); databases.push(database);
  const directory = new AdminDirectory(new SqliteAdminDirectoryStore({
    sql: { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings); return { toArray: () => rows }; } },
    transactionSync(callback) {
      database.exec("BEGIN IMMEDIATE");
      try { const result = callback(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  }));
  await directory.bootstrap("alice@example.com");
  const identity = { issuer: "https://accounts.google.com", subject: "alice", email: "alice@example.com", emailVerified: true };
  const admin = await directory.bindGoogleIdentity(identity);
  let session: AdminBrowserSession | null = { actor: { ...identity, adminId: admin.adminId }, csrfToken: "test-csrf", expiresAt: timestamp + 3600_000, authenticatedAt: timestamp };
  const currentSession = vi.fn(async () => session);
  const handler = createAdminHandler({ directory, origin, currentSession, now: () => timestamp });
  const send = (path: string, init?: RequestInit) => handler(new Request(`${origin}/admin/api/v1${path}`, init));
  const headers = { Origin: origin, "X-CSRF-Token": "test-csrf", "Idempotency-Key": "add-bob", "Content-Type": "application/json" };
  return { database, directory, admin, currentSession, handler, send, headers, session: session!, setSession: (value: AdminBrowserSession | null) => { session = value; } };
}
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

it("keeps management routing separate and rejects missing, expired or revoked sessions", async () => {
  const fixture = await setup();
  expect(await fixture.handler(new Request(`${origin}/tenants/alice/docs/markdown/`))).toBeNull();
  expect(fixture.currentSession).not.toHaveBeenCalled();
  fixture.setSession(null);
  expect((await fixture.send("/administrators"))!.status).toBe(401);
  fixture.setSession({ ...fixture.session, expiresAt: timestamp });
  expect((await fixture.send("/administrators"))!.status).toBe(401);
  fixture.setSession({ ...fixture.session, actor: { ...fixture.session.actor, adminId: "removed" } });
  expect((await fixture.send("/administrators"))!.status).toBe(403);
});

it("requires origin, CSRF and recent authentication before any mutation", async () => {
  const fixture = await setup();
  for (const headers of [{ ...fixture.headers, Origin: "https://evil.test" }, { ...fixture.headers, "X-CSRF-Token": "wrong" }]) {
    expect((await fixture.send("/administrators", { method: "POST", headers, body: JSON.stringify({ email: "bob@example.com" }) }))!.status).toBe(403);
  }
  fixture.setSession({ ...fixture.session, authenticatedAt: timestamp - 15 * 60_000 });
  const stale = await fixture.send("/administrators", { method: "POST", headers: fixture.headers, body: JSON.stringify({ email: "bob@example.com" }) });
  expect(await stale!.json()).toMatchObject({ error: { code: "reauthentication_required" } });
  expect(await fixture.directory.list(fixture.session.actor)).toHaveLength(1);
});

it("adds once, paginates public records, requires delete preconditions and audits once", async () => {
  const fixture = await setup();
  const input = { method: "POST", headers: fixture.headers, body: JSON.stringify({ email: "bob@example.com" }) };
  const first = await fixture.send("/administrators", input);
  expect(first!.status).toBe(201);
  expect(first!.headers.get("Cache-Control")).toBe("no-store");
  const body = await first!.json() as { data: { adminId: string; etag: string } };
  expect(await (await fixture.send("/administrators", input))!.json()).toEqual(body);
  const firstPage = await (await fixture.send("/administrators?limit=1"))!.json() as { items: unknown[]; nextCursor: string };
  expect(firstPage.items).toHaveLength(1);
  const lastPage = await (await fixture.send(`/administrators?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`))!.json();
  expect(lastPage).toMatchObject({ items: [{ email: "bob@example.com", bound: false }], nextCursor: null });
  expect(JSON.stringify(lastPage)).not.toContain("subject");
  expect((await fixture.send("/administrators?limit=101"))!.status).toBe(400);
  const path = `/administrators/${body.data.adminId}`;
  expect((await fixture.send(path, { method: "DELETE", headers: fixture.headers }))!.status).toBe(428);
  const deleteHeaders = { ...fixture.headers, "Idempotency-Key": "remove-bob", "If-Match": body.data.etag };
  expect((await fixture.send(path, { method: "DELETE", headers: deleteHeaders }))!.status).toBe(204);
  expect((await fixture.send(path, { method: "DELETE", headers: deleteHeaders }))!.status).toBe(204);
  expect((await fixture.directory.listAudit(fixture.session.actor)).filter(event => event.action === "administrator.removed")).toHaveLength(1);
});

it("rejects self-removal even when a client bypasses disabled UI controls", async () => {
  const fixture = await setup();
  const result = await fixture.send(`/administrators/${fixture.admin.adminId}`, { method: "DELETE", headers: { ...fixture.headers, "If-Match": administratorEtag(fixture.admin), "Idempotency-Key": "self" } });
  expect(result!.status).toBe(409);
  expect(await result!.json()).toMatchObject({ error: { code: "self_removal_forbidden" } });
});

it("bounds streaming JSON and rejects identity fields supplied by clients", async () => {
  const fixture = await setup();
  for (const body of ["{", JSON.stringify({ email: "bob@example.com", emailVerified: true }), JSON.stringify({ email: "bob@example.com", subject: "bob" })]) {
    expect((await fixture.send("/administrators", { method: "POST", headers: fixture.headers, body }))!.status).toBe(400);
  }
  expect((await fixture.send("/administrators", { method: "POST", headers: fixture.headers, body: JSON.stringify({ email: "x".repeat(5000) }) }))!.status).toBe(413);
  expect((await fixture.send("/administrators", { method: "POST", headers: { ...fixture.headers, "Content-Type": "text/plain" }, body: "{}" }))!.status).toBe(415);
  expect(await fixture.directory.list(fixture.session.actor)).toHaveLength(1);
});

it("does not expose bootstrap and sanitizes storage errors", async () => {
  const fixture = await setup();
  expect((await fixture.send("/bootstrap", { method: "POST", headers: fixture.headers, body: "{}" }))!.status).toBe(404);
  fixture.database.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON unidocs_admin_audit BEGIN SELECT RAISE(ABORT, 'sensitive storage detail'); END");
  const result = await fixture.send("/administrators", { method: "POST", headers: fixture.headers, body: JSON.stringify({ email: "bob@example.com" }) });
  expect(result!.status).toBe(503);
  expect(await result!.text()).not.toContain("sensitive storage detail");
  expect(await fixture.directory.list(fixture.session.actor)).toHaveLength(1);
});