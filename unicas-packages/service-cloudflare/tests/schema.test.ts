import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { migrateControlSchema } from "../src/control-schema.js";
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

describe("control schema", () => {
  test("creates the Playground business root catalog", async () => {
    const database = await createDb();
    await migrateControlSchema(database);
    const table = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cas_playground_file_roots'",
    ).first<{ name: string }>();
    expect(table?.name).toBe("cas_playground_file_roots");
  });

  test("upgrades only legacy managed capability lifetimes", async () => {
    const database = await createDb();
    await migrateControlSchema(database);
    const insert = `INSERT INTO cas_stack_managed_issuers
      (stack_id, issuer, audience, metadata_url, authorization_endpoint, token_endpoint, jwks_uri, status, verified_at, jwks_digest, capability_max_lifetime_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, 'digest', ?)`;
    await database.batch([
      database.prepare(insert).bind("cas_legacy", "https://issuer.example/legacy", "https://cas.example/legacy", "https://issuer.example/legacy/metadata", "https://issuer.example/legacy/authorize", "https://issuer.example/legacy/token", "https://issuer.example/legacy/jwks", 120),
      database.prepare(insert).bind("cas_custom", "https://issuer.example/custom", "https://cas.example/custom", "https://issuer.example/custom/metadata", "https://issuer.example/custom/authorize", "https://issuer.example/custom/token", "https://issuer.example/custom/jwks", 600),
    ]);

    await migrateControlSchema(database);

    const rows = await database.prepare(
      "SELECT stack_id, capability_max_lifetime_seconds, revision FROM cas_stack_managed_issuers ORDER BY stack_id",
    ).all<{ stack_id: string; capability_max_lifetime_seconds: number; revision: number }>();
    expect(rows.results).toEqual([
      { stack_id: "cas_custom", capability_max_lifetime_seconds: 600, revision: 1 },
      { stack_id: "cas_legacy", capability_max_lifetime_seconds: 3600, revision: 2 },
    ]);
  });
});
