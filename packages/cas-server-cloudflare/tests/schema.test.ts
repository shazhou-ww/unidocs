import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import {
  migrateStackTenantSchema,
  readCutoverState,
  readLegacyStackId,
  writeCutoverState,
  writeLegacyStackId,
} from "../src/schema.js";
import {
  CutoverController,
  canTransitionCutover,
  shouldUseStacklessFallback,
} from "../src/cutover.js";

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
      "cas_schema_meta",
      "cas_r2_migration_manifest",
    ]) {
      expect(names.has(expected), `missing table ${expected}`).toBe(true);
    }
    // No legacy stackless or owner tables in the canonical schema.
    expect(names.has("cas_root_owners")).toBe(false);
  });

  test("nodes are keyed by (stack_id, tenant_id, hash)", async () => {
    const database = await createDb();
    const columns = await database.prepare("PRAGMA table_info(cas_nodes)").all<{ name: string; pk: number }>();
    const pk = columns.results!.filter((column) => column.pk > 0).map((column) => column.name);
    expect(pk).toEqual(["stack_id", "tenant_id", "hash"]);
  });

  test("schema meta round-trips cutover state and the legacy stack id", async () => {
    const database = await createDb();
    expect(await readCutoverState(database)).toBe("provisioned");
    await writeLegacyStackId(database, "cas_legacy");
    expect(await readLegacyStackId(database)).toBe("cas_legacy");
    await writeCutoverState(database, "migrating");
    expect(await readCutoverState(database)).toBe("migrating");
  });
});

describe("cutover phase machine", () => {
  test("allowed transitions and rollback-marker reversal", () => {
    expect(canTransitionCutover("provisioned", "migrating")).toBe(true);
    expect(canTransitionCutover("migrating", "cutover")).toBe(true);
    expect(canTransitionCutover("cutover", "contracted")).toBe(true);
    expect(canTransitionCutover("cutover", "migrating")).toBe(true); // rollback
    expect(canTransitionCutover("migrating", "provisioned")).toBe(true);
    expect(canTransitionCutover("contracted", "cutover")).toBe(false); // no downgrade
    expect(canTransitionCutover("provisioned", "contracted")).toBe(false);
    expect(canTransitionCutover("provisioned", "cutover")).toBe(false);
  });

  test("stackless R2 fallback is legacy-stack-only and non-contracted", () => {
    expect(shouldUseStacklessFallback("cas_legacy", "migrating", "cas_legacy")).toBe(true);
    expect(shouldUseStacklessFallback("cas_legacy", "cutover", "cas_legacy")).toBe(true);
    expect(shouldUseStacklessFallback("cas_legacy", "contracted", "cas_legacy")).toBe(false);
    // A non-legacy stack must never probe stackless keys.
    expect(shouldUseStacklessFallback("cas_other", "migrating", "cas_legacy")).toBe(false);
    expect(shouldUseStacklessFallback("cas_legacy", "migrating", null)).toBe(false);
  });

  test("the gate blocks second-stack tenant traffic until contract", async () => {
    const database = await createDb();
    const controller = new CutoverController(database);
    // No legacy stack configured: nothing may serve yet.
    expect(await controller.allowStackTenantTraffic("cas_any")).toBe(false);
    await writeLegacyStackId(database, "cas_legacy");
    expect(await controller.allowStackTenantTraffic("cas_legacy")).toBe(true);
    expect(await controller.allowStackTenantTraffic("cas_other")).toBe(false);
    await controller.transition("migrating");
    await controller.transition("cutover");
    expect(await controller.allowStackTenantTraffic("cas_other")).toBe(false);
    await controller.transition("contracted");
    expect(await controller.allowStackTenantTraffic("cas_other")).toBe(true);
  });
});
