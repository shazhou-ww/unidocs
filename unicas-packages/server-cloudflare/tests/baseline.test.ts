import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { migrateStackTenantSchema } from "../src/schema.js";
import { runLegacyBaseline } from "../src/baseline.js";
import { LEGACY_DOMAIN } from "@unicas/control-plane";

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
      name: "baseline-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "baseline-test-db" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "baseline-test");
  await migrateStackTenantSchema(db);
  return db;
}

const STACK = "cas_legacy";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);

async function events(): Promise<Array<Record<string, unknown>>> {
  return (await db!.prepare(
    "SELECT revision, tenant_id, request_id, payload_hash, changes_json FROM cas_root_domain_events WHERE stack_id = ? AND ref_domain = ? ORDER BY revision",
  ).bind(STACK, LEGACY_DOMAIN).all<Record<string, unknown>>()).results ?? [];
}

describe("_legacy baseline migration", () => {
  test("writes deterministic events and balances without touching aggregates", async () => {
    const database = await createDb();
    const result = await runLegacyBaseline(database, {
      stackId: STACK,
      rows: [
        { tenantId: "tenant-b", hash: H2, rootRefCount: 2 },
        { tenantId: "tenant-a", hash: H1, rootRefCount: 3 },
        { tenantId: "tenant-a", hash: H3, rootRefCount: 1 },
        { tenantId: "tenant-a", hash: H1, rootRefCount: 0 }, // skipped (non-positive)
        { tenantId: "tenant-a", hash: H2, rootRefCount: -1 }, // skipped
      ],
    });
    expect(result.batches).toBe(2); // tenant-a (2 hashes) + tenant-b (1 hash)
    expect(result.events).toBe(2);
    expect(result.projectionRows).toBe(3);
    expect(result.finalRevision).toBe(2);

    const rows = await events();
    expect(rows).toHaveLength(2);
    // Canonical tenant order: tenant-a first.
    expect(rows[0]).toMatchObject({ revision: 1, tenant_id: "tenant-a", request_id: `baseline:1:${STACK}:tenant-a:0` });
    expect(rows[1]).toMatchObject({ revision: 2, tenant_id: "tenant-b", request_id: `baseline:1:${STACK}:tenant-b:0` });
    // Canonical hash order inside the tenant-a batch.
    expect(JSON.parse(rows[0]!.changes_json as string)).toEqual({ [H1]: 3, [H3]: 1 });

    const balances = (await database.prepare(
      "SELECT tenant_id, hash, ref_count FROM cas_root_domain_refs WHERE stack_id = ? AND ref_domain = ? ORDER BY tenant_id, hash",
    ).bind(STACK, LEGACY_DOMAIN).all<{ tenant_id: string; hash: string; ref_count: number }>()).results!;
    expect(balances).toEqual([
      { tenant_id: "tenant-a", hash: H1, ref_count: 3 },
      { tenant_id: "tenant-a", hash: H3, ref_count: 1 },
      { tenant_id: "tenant-b", hash: H2, ref_count: 2 },
    ]);

    const revision = await database.prepare(
      "SELECT revision FROM cas_root_domain_revisions WHERE stack_id = ? AND ref_domain = ?",
    ).bind(STACK, LEGACY_DOMAIN).first<{ revision: number }>();
    expect(revision?.revision).toBe(2);

    // Aggregates are untouched: cas_nodes is empty.
    const nodes = await database.prepare("SELECT COUNT(*) AS count FROM cas_nodes").first<{ count: number }>();
    expect(nodes?.count).toBe(0);
  });

  test("rerunning matches request IDs and payloads and appends nothing", async () => {
    const database = await createDb();
    const rows = [
      { tenantId: "tenant-a", hash: H1, rootRefCount: 3 },
      { tenantId: "tenant-b", hash: H2, rootRefCount: 2 },
    ];
    const first = await runLegacyBaseline(database, { stackId: STACK, rows });
    const second = await runLegacyBaseline(database, { stackId: STACK, rows });
    expect(second).toEqual({ ...first, batches: 2, events: 0, projectionRows: 0 });
    // Same request IDs and payload hashes, no duplicate events.
    expect(await events()).toHaveLength(2);
    const count = await database.prepare(
      "SELECT COUNT(*) AS count FROM cas_root_domain_refs WHERE stack_id = ? AND ref_domain = ?",
    ).bind(STACK, LEGACY_DOMAIN).first<{ count: number }>();
    expect(count?.count).toBe(2);
  });

  test("batch splitting uses at most the configured batch size per tenant", async () => {
    const database = await createDb();
    const rows = Array.from({ length: 60 }, (_, i) => ({
      tenantId: "tenant-a",
      hash: String(i).padStart(64, "0"),
      rootRefCount: 1,
    }));
    const result = await runLegacyBaseline(database, { stackId: STACK, rows, maxBatchSize: 25 });
    expect(result.batches).toBe(3);
    expect(result.events).toBe(3);
    const revisions = (await events()).map((event) => event.revision as number);
    expect(revisions).toEqual([1, 2, 3]);
  });

  test("a stack with no positive counts creates no events (revision zero)", async () => {
    const database = await createDb();
    const result = await runLegacyBaseline(database, {
      stackId: STACK,
      rows: [{ tenantId: "t", hash: H1, rootRefCount: 0 }],
    });
    expect(result.batches).toBe(0);
    expect(await events()).toHaveLength(0);
  });
});
