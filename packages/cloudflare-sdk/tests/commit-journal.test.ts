import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteCommitJournal, type CommitJournalStorage } from "../src/commit-journal.js";

const scope = { tenantId: "tenant", docType: "markdown", sessionId: "session" };
const payload = { baseVersion: 1, description: "edit", operations: [{ kind: "setContent", payload: { content: "# Draft" } }] };
const databases: DatabaseSync[] = [];
const directories: string[] = [];

function open(path = ":memory:") {
  const database = new DatabaseSync(path);
  databases.push(database);
  const storage: CommitJournalStorage = {
    sql: { exec(query, ...bindings) {
      const statement = database.prepare(query);
      const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      const rows = statement.all(...values);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      database.exec("BEGIN IMMEDIATE");
      try { const result = callback(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
  return { database, storage, journal: new SqliteCommitJournal(storage, scope) };
}

afterEach(() => {
  for (const database of databases.splice(0)) { if (database.isOpen) database.close(); }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("persists the original candidate across database close and reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "commit-journal-")); directories.push(directory);
  const path = join(directory, "journal.sqlite");
  const first = open(path);
  const candidate = structuredClone(payload);
  const pending = first.journal.begin("op-1", candidate);
  candidate.operations[0]!.payload.content = "later";
  const receipt = await pending;
  first.database.close();
  const restored = open(path);
  expect(await restored.journal.recoverPending()).toEqual({ receipt, payload });
  expect(await restored.journal.begin("op-1", payload)).toEqual(receipt);
});

it("deduplicates concurrent requests but rejects changed payloads and competing pending intents", async () => {
  const { journal } = open();
  const [first, retry] = await Promise.all([journal.begin("op-1", payload), journal.begin("op-1", payload)]);
  expect(retry).toEqual(first);
  await expect(journal.begin("op-1", { ...payload, description: "changed" })).rejects.toMatchObject({ code: "payload_mismatch" });
  await expect(journal.begin("op-2", payload)).rejects.toMatchObject({ code: "pending_exists" });
  expect(await journal.recoverPending()).toEqual({ receipt: first, payload });
});

it("commits local writes and terminal receipt atomically and never runs duplicate finalization", async () => {
  const { journal, storage } = open();
  storage.sql.exec("CREATE TABLE committed_versions(version INTEGER PRIMARY KEY)");
  const pending = await journal.begin("op-1", payload);
  const committed = { ...pending, state: "committed" as const, version: 2 };
  const finalize = vi.fn(() => { storage.sql.exec("INSERT INTO committed_versions VALUES (2)"); });
  expect(journal.settle(committed, finalize)).toEqual(committed);
  expect(journal.settle(committed, finalize)).toEqual(committed);
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(await journal.begin("op-1", payload)).toEqual(committed);
  expect(await journal.recoverPending()).toBeNull();
  expect(() => journal.settle({ ...pending, state: "rejected", reason: "invalid_operations" }, finalize)).toThrow("terminal_mismatch");
  expect((await journal.begin("op-2", { ...payload, baseVersion: 2 })).state).toBe("pending");
});

it("rolls back local writes and retains pending on finalization failure", async () => {
  const { journal, storage } = open();
  storage.sql.exec("CREATE TABLE committed_versions(version INTEGER PRIMARY KEY)");
  const pending = await journal.begin("op-1", payload);
  expect(() => journal.settle({ ...pending, state: "committed", version: 2 }, () => {
    storage.sql.exec("INSERT INTO committed_versions VALUES (2)");
    throw new Error("disk failure");
  })).toThrow("disk failure");
  expect(storage.sql.exec("SELECT * FROM committed_versions").toArray()).toEqual([]);
  expect(journal.lookup(pending)).toEqual(pending);
});

it("isolates tenant, type and session and returns unknown for absent identities", async () => {
  const { journal, storage } = open();
  const pending = await journal.begin("op-1", payload);
  for (const key of ["tenantId", "docType", "sessionId"] as const) {
    const other = new SqliteCommitJournal(storage, { ...scope, [key]: "other" });
    expect(other.lookup(pending)).toMatchObject({ state: "unknown", reason: "not_found" });
    expect((await other.begin("op-1", payload)).requestDigest).not.toBe(pending.requestDigest);
  }
  expect(() => journal.lookup({ ...pending, requestDigest: "0".repeat(64) })).toThrow("payload_mismatch");
});

it("keeps corrupt payloads and receipt metadata from being recovered as valid", async () => {
  const { journal, storage } = open();
  const pending = await journal.begin("op-1", payload);
  storage.sql.exec("UPDATE doc_commit_intents_v1 SET payload = ?", new Uint8Array([0]).buffer);
  await expect(journal.recoverPending()).rejects.toThrow();
  storage.sql.exec("UPDATE doc_commit_intents_v1 SET state = 'committed'");
  expect(() => journal.lookup(pending)).toThrow("Stored commit identity mismatch");
});

it("rolls back local finalization when the receipt write fails", async () => {
  const { journal, storage } = open();
  storage.sql.exec("CREATE TABLE committed_versions(version INTEGER PRIMARY KEY)");
  storage.sql.exec(`CREATE TRIGGER reject_terminal BEFORE UPDATE ON doc_commit_intents_v1
    BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END`);
  const pending = await journal.begin("op-1", payload);
  expect(() => journal.settle({ ...pending, state: "committed", version: 2 }, () => {
    storage.sql.exec("INSERT INTO committed_versions VALUES (2)");
  })).toThrow("injected receipt write failure");
  expect(storage.sql.exec("SELECT * FROM committed_versions").toArray()).toEqual([]);
  expect(journal.lookup(pending)).toEqual(pending);
});

it("retains definitive rejection, releases the pending slot and refuses terminal rewrites", async () => {
  const { journal } = open();
  const pending = await journal.begin("op-1", payload);
  const rejected = { ...pending, state: "rejected" as const, reason: "version_conflict" as const, headVersion: 3 };
  expect(journal.settle(rejected, () => undefined)).toEqual(rejected);
  expect(await journal.begin("op-1", payload)).toEqual(rejected);
  expect(journal.lookup(pending)).toEqual(rejected);
  expect(() => journal.settle({ ...pending, state: "committed", version: 2 }, () => undefined)).toThrow("terminal_mismatch");
  expect((await journal.begin("op-2", { ...payload, baseVersion: 3 })).state).toBe("pending");
});

it("does not register oversize or invalid candidates", async () => {
  const { journal } = open();
  await expect(journal.begin("invalid/id", payload)).rejects.toThrow();
  await expect(journal.begin("op-1", { ...payload, description: "x".repeat(1_048_576) })).rejects.toThrow("limit");
  expect(await journal.recoverPending()).toBeNull();
});