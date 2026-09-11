import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let miniflare;
let database;

beforeEach(async () => {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "portal-atomicity-spike",
      modules: true,
      script: "export default { fetch() { return new Response('spike'); } };",
      compatibilityDate: "2026-08-18",
      d1Databases: { DB: `portal-${crypto.randomUUID()}` },
    }],
  }));
  database = await miniflare.getD1Database("DB", "portal-atomicity-spike");
  await database.batch([
    database.prepare("CREATE TABLE types (id TEXT PRIMARY KEY, last_idx INTEGER NOT NULL DEFAULT -1, revision INTEGER NOT NULL DEFAULT 0)"),
    database.prepare("CREATE TABLE contracts (type_id TEXT NOT NULL REFERENCES types(id), idx INTEGER NOT NULL CHECK (idx >= 0), hash TEXT NOT NULL, PRIMARY KEY (type_id, idx), UNIQUE (type_id, hash))"),
    database.prepare("CREATE TABLE receipts (actor TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT, PRIMARY KEY (actor, operation, key))"),
    database.prepare("CREATE TABLE audit (id TEXT PRIMARY KEY, type_id TEXT NOT NULL, idx INTEGER NOT NULL, FOREIGN KEY (type_id, idx) REFERENCES contracts(type_id, idx))"),
    database.prepare("CREATE TABLE mutation_guard (valid INTEGER NOT NULL CHECK (valid = 1))"),
    database.prepare("INSERT INTO types (id) VALUES ('markdown'), ('psd')"),
  ]);
});

afterEach(async () => {
  await miniflare?.dispose();
});

async function append({ key, hash = key, actor = "admin", type = "markdown", revision = null, auditId = crypto.randomUUID() }) {
  const fingerprint = JSON.stringify({ type, hash, revision });
  try {
    const results = await database.batch([
      database.prepare("INSERT INTO receipts (actor, operation, key, fingerprint) VALUES (?, 'append', ?, ?)").bind(actor, key, fingerprint),
      database.prepare("UPDATE types SET last_idx = last_idx + 1, revision = revision + 1 WHERE id = ? AND (? IS NULL OR revision = ?)").bind(type, revision, revision),
      database.prepare("INSERT INTO mutation_guard (valid) VALUES (changes())"),
      database.prepare("DELETE FROM mutation_guard"),
      database.prepare("INSERT INTO contracts (type_id, idx, hash) SELECT id, last_idx, ? FROM types WHERE id = ?").bind(hash, type),
      database.prepare("INSERT INTO audit (id, type_id, idx) SELECT ?, id, last_idx FROM types WHERE id = ?").bind(auditId, type),
      database.prepare("UPDATE receipts SET response = (SELECT json_object('idx', last_idx) FROM types WHERE id = ?) WHERE actor = ? AND operation = 'append' AND key = ? RETURNING response").bind(type, actor, key),
    ]);
    return JSON.parse(results.at(-1).results[0].response);
  } catch (error) {
    const receipt = await database.prepare("SELECT fingerprint, response FROM receipts WHERE actor = ? AND operation = 'append' AND key = ?").bind(actor, key).first();
    if (!receipt) throw error;
    if (receipt.fingerprint !== fingerprint) throw new Error("idempotency_conflict");
    return JSON.parse(receipt.response);
  }
}

async function counts() {
  return database.prepare(`SELECT
    (SELECT COUNT(*) FROM contracts) AS contracts,
    (SELECT COUNT(*) FROM receipts) AS receipts,
    (SELECT COUNT(*) FROM audit) AS audit,
    (SELECT COUNT(*) FROM mutation_guard) AS guards`).first();
}

describe("Portal Phase 0: D1 atomic mutation spike", () => {
  test("allocates contiguous zero-based revisions under concurrent append, independently per type", async () => {
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => append({ key: `append-${index}` })));
    expect(results.map(result => result.idx).sort((left, right) => left - right)).toEqual(Array.from({ length: 24 }, (_, index) => index));
    expect(await append({ key: "psd-first", type: "psd" })).toEqual({ idx: 0 });
    expect(await counts()).toEqual({ contracts: 25, receipts: 25, audit: 25, guards: 0 });
  }, 30_000);

  test("concurrent retries replay one committed response and reject a different fingerprint", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => append({ key: "retry" })));
    expect(results).toEqual(Array.from({ length: 12 }, () => ({ idx: 0 })));
    await expect(append({ key: "retry", hash: "different" })).rejects.toThrow("idempotency_conflict");
    expect(await counts()).toEqual({ contracts: 1, receipts: 1, audit: 1, guards: 0 });
  }, 30_000);

  test("only one conditional update wins and losing receipts are rolled back", async () => {
    const results = await Promise.allSettled([
      append({ key: "left", revision: 0 }),
      append({ key: "right", revision: 0 }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await counts()).toEqual({ contracts: 1, receipts: 1, audit: 1, guards: 0 });
    expect(await append({ key: "next", revision: 1 })).toEqual({ idx: 1 });
  });

  test("audit failure rolls back the contract, counter and receipt without an idx gap", async () => {
    await append({ key: "first", auditId: "audit-collision" });
    await expect(append({ key: "second", auditId: "audit-collision" })).rejects.toThrow();
    expect(await counts()).toEqual({ contracts: 1, receipts: 1, audit: 1, guards: 0 });
    expect(await append({ key: "second" })).toEqual({ idx: 1 });
  });

  test("duplicate content and missing types leave no partial records", async () => {
    await append({ key: "first", hash: "same-content" });
    await expect(append({ key: "second", hash: "same-content" })).rejects.toThrow();
    await expect(append({ key: "missing", type: "absent" })).rejects.toThrow();
    expect(await counts()).toEqual({ contracts: 1, receipts: 1, audit: 1, guards: 0 });
    expect(await append({ key: "third" })).toEqual({ idx: 1 });
  });

  test("idempotency keys are isolated by authenticated actor", async () => {
    expect(await append({ key: "shared", actor: "admin-one", hash: "one" })).toEqual({ idx: 0 });
    expect(await append({ key: "shared", actor: "admin-two", hash: "two" })).toEqual({ idx: 1 });
    expect(await counts()).toEqual({ contracts: 2, receipts: 2, audit: 2, guards: 0 });
  });
});