import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { migrateStackTenantSchema } from "../src/schema.js";

let miniflare: Miniflare | undefined;
let db: D1Database | undefined;

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
  db = undefined;
});

async function createDb(): Promise<D1Database> {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "task5-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "task5-test-db" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "task5-test");
  await migrateStackTenantSchema(db);
  return db;
}

describe("stack-scoped tenant schema", () => {
  test("creates stack-aware authoritative and audit tables, idempotently", async () => {
    const database = await createDb();
    await migrateStackTenantSchema(database); // rerun must be a no-op

    const tables = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = new Set(tables.results!.map((row) => row.name));
    for (const expected of [
      "cas_nodes",
      "cas_edges",
      "cas_root_ref_requests",
      "cas_root_domain_events",
      "cas_root_domain_refs",
      "cas_root_domain_revisions",
      "cas_upload_reservations",
    ]) {
      expect(names.has(expected), `missing table ${expected}`).toBe(true);
    }
    expect(names.has("cas_root_owners")).toBe(false);
    expect(names.has("cas_schema_meta")).toBe(false);
    expect(names.has("cas_r2_migration_manifest")).toBe(false);
  });

  test("nodes are keyed by (stack_id, tenant_id, hash)", async () => {
    const database = await createDb();
    const columns = await database.prepare("PRAGMA table_info(cas_nodes)").all<{ name: string; pk: number; dflt_value: string | null }>();
    const pk = columns.results!.filter((column) => column.pk > 0).map((column) => column.name);
    expect(pk).toEqual(["stack_id", "tenant_id", "hash"]);
    expect(columns.results!.some((column) => column.name === "object_format")).toBe(false);
  });
});
