import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AdminDirectory, normalizeAdminEmail, type AdminActor } from "@unidocs/gateway-common";
import { SqliteAdminDirectoryStore, type AdminSqliteStorage } from "../src/admin-directory-sqlite.js";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
const identity = (email: string) => ({ issuer: "https://accounts.google.com", subject: email, email, emailVerified: true });
function open(path = ":memory:") {
  const database = new DatabaseSync(path); databases.push(database);
  const storage: AdminSqliteStorage = {
    sql: { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings); return { toArray: () => rows }; } },
    transactionSync(callback) {
      database.exec("BEGIN IMMEDIATE");
      try { const result = callback(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
  return { database, directory: new AdminDirectory(new SqliteAdminDirectoryStore(storage)) };
}
async function setup(path?: string) {
  const opened = open(path);
  await opened.directory.bootstrap("alice@example.com");
  const alice = await opened.directory.bindGoogleIdentity(identity("alice@example.com"));
  const actor: AdminActor = { ...identity(alice.email), adminId: alice.adminId };
  await opened.directory.add(actor, "bob@example.com", "add-bob");
  const bob = await opened.directory.bindGoogleIdentity(identity("bob@example.com"));
  return { ...opened, alice, actor, bob, other: { ...identity(bob.email), adminId: bob.adminId } };
}
afterEach(() => {
  for (const database of databases.splice(0)) if (database.isOpen) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("normalizes emails without collapsing aliases and rejects malformed inputs", () => {
  expect(normalizeAdminEmail(" Alice.Name+Ops@EXAMPLE.COM ")).toBe("alice.name+ops@example.com");
  for (const value of ["bad", "a..b@example.com", ".a@example.com", "a.@example.com", "a@-example.com", "用户@example.com"]) expect(() => normalizeAdminEmail(value)).toThrow("invalid_email");
});

it("bootstraps only once and never lets an arbitrary login claim an empty directory", async () => {
  const { directory } = open();
  await expect(directory.bindGoogleIdentity(identity("first@example.com"))).rejects.toMatchObject({ code: "administrator_required" });
  await directory.bootstrap("alice@example.com");
  await expect(directory.bootstrap("other@example.com")).rejects.toMatchObject({ code: "already_initialized" });
  await expect(directory.bindGoogleIdentity({ ...identity("alice@example.com"), emailVerified: false })).rejects.toMatchObject({ code: "invalid_google_identity" });
  await expect(directory.bindGoogleIdentity({ ...identity("alice@example.com"), issuer: "https://attacker.test" })).rejects.toMatchObject({ code: "invalid_google_identity" });
});

it("binds Google identity once and rejects reassigned email or unlisted accounts", async () => {
  const { directory, actor } = await setup();
  await expect(directory.bindGoogleIdentity({ ...identity(actor.email), subject: "reassigned" })).rejects.toMatchObject({ code: "identity_mismatch" });
  await expect(directory.bindGoogleIdentity(identity("outsider@example.com"))).rejects.toMatchObject({ status: 403 });
  expect((await directory.list(actor)).length).toBe(2);
});

it("forbids self removal and serializes competing reciprocal removals across stores", async () => {
  const folder = mkdtempSync(join(tmpdir(), "unidocs-admin-")); directories.push(folder);
  const path = join(folder, "admin.sqlite");
  const { directory, actor, alice, bob, other } = await setup(path);
  const second = open(path);
  await expect(directory.remove(actor, actor.adminId, alice.revision, "self")).rejects.toMatchObject({ code: "self_removal_forbidden" });
  const results = await Promise.allSettled([directory.remove(actor, bob.adminId, bob.revision, "remove-bob"), second.directory.remove(other, alice.adminId, alice.revision, "remove-alice")]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "administrator_required" } });
  expect(await directory.list(actor)).toHaveLength(1);
});

it("checks current membership before retries, and re-adding the email cannot revive old sessions", async () => {
  const { directory, actor, bob, other } = await setup();
  await directory.add(other, "carol@example.com", "carol");
  await directory.remove(actor, bob.adminId, bob.revision, "remove");
  await expect(directory.add(other, "carol@example.com", "carol")).rejects.toMatchObject({ status: 403 });
  const replacement = await directory.add(actor, bob.email, "re-add");
  expect(replacement.adminId).not.toBe(bob.adminId);
  await directory.bindGoogleIdentity(identity(bob.email));
  await expect(directory.current(other)).rejects.toMatchObject({ status: 403 });
});

it("deduplicates normalized commands, rejects changed payloads and stale revisions", async () => {
  const { directory, actor, bob } = await setup();
  const first = await directory.add(actor, " CAROL@EXAMPLE.COM ", "carol");
  expect(await directory.add(actor, "carol@example.com", "carol")).toEqual(first);
  await expect(directory.add(actor, "dave@example.com", "carol")).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(directory.remove(actor, bob.adminId, 1, "remove")).rejects.toMatchObject({ status: 412 });
  await directory.remove(actor, bob.adminId, bob.revision, "remove");
  expect(await directory.remove(actor, bob.adminId, bob.revision, "remove")).toEqual(bob);
  expect((await directory.listAudit(actor)).filter(event => event.action === "administrator.removed")).toHaveLength(1);
});

it("rolls back membership, bootstrap marker and command results when audit persistence fails", async () => {
  const { directory, database } = open();
  database.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON unidocs_admin_audit BEGIN SELECT RAISE(ABORT, 'audit failure'); END");
  await expect(directory.bootstrap("alice@example.com")).rejects.toThrow("audit failure");
  expect(database.prepare("SELECT * FROM unidocs_administrators").all()).toEqual([]);
  expect(database.prepare("SELECT * FROM unidocs_admin_state").all()).toEqual([]);
  database.exec("DROP TRIGGER fail_audit");
  await directory.bootstrap("alice@example.com");
  const alice = await directory.bindGoogleIdentity(identity("alice@example.com"));
  const actor = { ...identity(alice.email), adminId: alice.adminId };
  const bob = await directory.add(actor, "bob@example.com", "bob");
  database.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON unidocs_admin_audit BEGIN SELECT RAISE(ABORT, 'audit failure'); END");
  await expect(directory.remove(actor, bob.adminId, bob.revision, "remove")).rejects.toThrow("audit failure");
  expect(await directory.list(actor)).toHaveLength(2);
  expect(database.prepare("SELECT * FROM unidocs_admin_commands WHERE request_key = 'remove'").all()).toEqual([]);
});

it("retains bound identities and idempotency records across disk close and reopen", async () => {
  const folder = mkdtempSync(join(tmpdir(), "unidocs-admin-")); directories.push(folder);
  const path = join(folder, "admin.sqlite");
  const { database, directory, actor } = await setup(path);
  const carol = await directory.add(actor, "carol@example.com", "carol");
  database.close();
  const reopened = open(path);
  expect(await reopened.directory.add(actor, "carol@example.com", "carol")).toEqual(carol);
  expect(await reopened.directory.list(actor)).toHaveLength(3);
  await expect(reopened.directory.bootstrap("new@example.com")).rejects.toMatchObject({ code: "already_initialized" });
});

it("fails closed and rolls back membership when audit or command storage reaches its limit", async () => {
  for (const table of ["unidocs_admin_audit", "unidocs_admin_commands"]) {
    const { database, directory, actor } = await setup();
    database.exec(`WITH RECURSIVE counters(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM counters WHERE value < 100000)
      ${table === "unidocs_admin_audit" ? "INSERT INTO unidocs_admin_audit(event_id, payload) SELECT 'capacity-' || value, '{}' FROM counters" : "INSERT INTO unidocs_admin_commands SELECT 'capacity', 'key-' || value, '{}' FROM counters"}`);
    await expect(directory.add(actor, "blocked@example.com", "capacity-write")).rejects.toThrow("capacity reached");
    expect(await directory.list(actor)).toHaveLength(2);
    expect(database.prepare("SELECT * FROM unidocs_admin_commands WHERE request_key = 'capacity-write'").all()).toEqual([]);
  }
});