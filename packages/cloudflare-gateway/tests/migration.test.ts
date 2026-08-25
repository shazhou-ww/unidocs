import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let miniflare: Miniflare | undefined;

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
});

describe("Gateway D1 migrations", () => {
  it("backfills legacy documents with their existing Durable Object name", async () => {
    miniflare = new Miniflare(convertV4MiniflareOptions({
      workers: [{
        name: "migration-test",
        modules: true,
        script: "export default { fetch() { return new Response('ok'); } };",
        compatibilityDate: "2025-08-17",
        d1Databases: { DB: "migration-test-db" },
      }],
    }));
    await miniflare.ready;
    const db = await miniflare.getD1Database("DB", "migration-test");
    const migration = (name: string) => fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
    await db.exec(await readFile(migration("0001_init.sql"), "utf8"));
    await db.prepare(
      "INSERT INTO docs (doc_id, doc_type, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("doc-1", "markdown", "alice", 100, 200).run();
    await db.prepare(
      "INSERT INTO snapshots (hash, doc_type, doc_id, version, timestamp) VALUES (?, ?, ?, ?, ?)",
    ).bind("hash-21", "markdown", "doc-1", 21, 200).run();

    await db.exec(await readFile(migration("0002_gateway_documents.sql"), "utf8"));

    await expect(db.prepare(
      "SELECT * FROM gateway_documents WHERE owner_id = ? AND doc_id = ?",
    ).bind("alice", "doc-1").first()).resolves.toMatchObject({
      tenant_id: "alice",
      service_id: "markdown",
      session_id: "alice:doc-1",
      state: "ready",
      version: 21,
    });

    await db.exec(await readFile(migration("0003_drop_legacy_doc_index.sql"), "utf8"));
    await db.exec(await readFile(migration("0004_requested_doc_id.sql"), "utf8"));
    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    expect(tables.results.map(table => table.name)).toContain("gateway_documents");
    expect(tables.results.map(table => table.name)).not.toContain("docs");
    expect(tables.results.map(table => table.name)).not.toContain("snapshots");
    expect(tables.results.map(table => table.name)).toContain("gateway_document_requests");
  }, 15_000);
});