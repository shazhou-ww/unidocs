import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { migrateStackTenantSchema } from "../src/schema.js";
import { canonicalizeRootRefsUpdate, executeDomainUpdate } from "../src/root-refs.js";
import {
  listRootDomainEvents,
  listRootDomainRefs,
  listRootDomains,
  AuditReadError,
} from "../src/audit-reads.js";
import { stackNodeKey } from "../src/do-names.js";

let miniflare: Miniflare | undefined;
let db: D1Database | undefined;
let bucket: R2Bucket | undefined;

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
  db = undefined;
  bucket = undefined;
});

async function createStore(): Promise<void> {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "audit-reads-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "audit-reads-test-db" },
      r2Buckets: { BUCKET: "audit-reads-test-bucket" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "audit-reads-test");
  bucket = await miniflare.getR2Bucket("BUCKET", "audit-reads-test");
  await migrateStackTenantSchema(db);
}

const STACK = "cas_stack_a";
const DOMAIN = "doc";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);

/** Seed a projection row + a revision watermark directly (migration-style). */
async function seedProjection(
  revision: number,
  rows: { tenantId: string; hash: string; count: number }[],
): Promise<void> {
  await db!.prepare(
    "INSERT INTO cas_root_domain_revisions (stack_id, ref_domain, revision) VALUES (?, ?, ?) ON CONFLICT(stack_id, ref_domain) DO UPDATE SET revision = MAX(revision, excluded.revision)",
  ).bind(STACK, DOMAIN, revision).run();
  for (const row of rows) {
    await db!.prepare(
      "INSERT INTO cas_root_domain_refs (stack_id, ref_domain, tenant_id, hash, ref_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(stack_id, ref_domain, tenant_id, hash) DO UPDATE SET ref_count = excluded.ref_count",
    ).bind(STACK, DOMAIN, row.tenantId, row.hash, row.count).run();
  }
}

async function seedEvent(revision: number, tenantId: string, requestId: string, changes: Record<string, number>): Promise<void> {
  await db!.prepare(
    "INSERT INTO cas_root_domain_revisions (stack_id, ref_domain, revision) VALUES (?, ?, ?) ON CONFLICT(stack_id, ref_domain) DO UPDATE SET revision = MAX(revision, excluded.revision)",
  ).bind(STACK, DOMAIN, revision).run();
  await db!.prepare(
    "INSERT INTO cas_root_domain_events (stack_id, ref_domain, revision, tenant_id, request_id, payload_hash, changes_json, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(STACK, DOMAIN, revision, tenantId, requestId, "p".repeat(64), JSON.stringify(changes), revision * 1000).run();
}

describe("listRootDomains", () => {
  test("lists only domains observed for the requested stack", async () => {
    await createStore();
    await seedProjection(3, []);
    await db!.prepare(
      "INSERT INTO cas_root_domain_revisions (stack_id, ref_domain, revision) VALUES (?, ?, ?)",
    ).bind(STACK, "asset", 2).run();
    await db!.prepare(
      "INSERT INTO cas_root_domain_revisions (stack_id, ref_domain, revision) VALUES (?, ?, ?)",
    ).bind("cas_other", "other", 9).run();

    expect(await listRootDomains({ db: db!, stackId: STACK })).toEqual([
      { stackId: STACK, refDomain: "asset", revision: 2 },
      { stackId: STACK, refDomain: DOMAIN, revision: 3 },
    ]);
    expect(await listRootDomains({ db: db!, stackId: "cas_empty" })).toEqual([]);
  });
});

describe("listRootDomainRefs", () => {
  test("an empty domain returns revision zero and no rows", async () => {
    await createStore();
    const page = await listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN });
    expect(page).toEqual({ revision: 0, refs: [], nextCursor: null });
  });

  test("pages are ordered by (tenantId, hash) with positive and negative balances", async () => {
    await createStore();
    await seedProjection(7, [
      { tenantId: "tenant-b", hash: H3, count: -2 },
      { tenantId: "tenant-a", hash: H2, count: 1 },
      { tenantId: "tenant-a", hash: H1, count: 3 },
      { tenantId: "tenant-c", hash: H1, count: 0 }, // zero rows are absent by invariant
    ].filter((row) => row.count !== 0));
    const page = await listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN, limit: 2 });
    expect(page.revision).toBe(7);
    expect(page.refs).toEqual([
      { tenantId: "tenant-a", hash: H1, count: 3 },
      { tenantId: "tenant-a", hash: H2, count: 1 },
    ]);
    expect(page.nextCursor).not.toBeNull();

    const second = await listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN, limit: 2, cursor: page.nextCursor! });
    expect(second.refs).toEqual([{ tenantId: "tenant-b", hash: H3, count: -2 }]);
    expect(second.nextCursor).toBeNull();
  });

  test("tenant filter returns only that tenant and binds the cursor", async () => {
    await createStore();
    await seedProjection(3, [
      { tenantId: "tenant-a", hash: H1, count: 1 },
      { tenantId: "tenant-a", hash: H2, count: 2 },
      { tenantId: "tenant-b", hash: H1, count: 5 },
    ]);
    const page = await listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN, tenantId: "tenant-a", limit: 1 });
    expect(page.refs).toEqual([{ tenantId: "tenant-a", hash: H1, count: 1 }]);
    const second = await listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN, tenantId: "tenant-a", limit: 1, cursor: page.nextCursor! });
    expect(second.refs).toEqual([{ tenantId: "tenant-a", hash: H2, count: 2 }]);
    // A cursor bound to a different filter is rejected.
    await expect(listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN, tenantId: "tenant-b", limit: 1, cursor: page.nextCursor! }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
  });

  test("a stale cursor returns ROOT_REF_SNAPSHOT_CHANGED", async () => {
    await createStore();
    await seedProjection(1, [
      { tenantId: "tenant-a", hash: H1, count: 1 },
      { tenantId: "tenant-a", hash: H2, count: 1 },
    ]);
    const page = await listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN, limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    await seedProjection(2, [{ tenantId: "tenant-a", hash: H3, count: 1 }]); // revision moves
    await expect(listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN, limit: 1, cursor: page.nextCursor! }))
      .rejects.toMatchObject({ status: 409, code: "ROOT_REF_SNAPSHOT_CHANGED" });
  });

  test("malformed, wrong-domain, and invalid-limit inputs are rejected", async () => {
    await createStore();
    await seedProjection(1, [{ tenantId: "tenant-a", hash: H1, count: 1 }]);
    await expect(listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN, cursor: "!!!" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
    await expect(listRootDomainRefs({ db: db!, stackId: STACK, refDomain: DOMAIN, limit: 2000 }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    await expect(listRootDomainRefs({ db: db!, stackId: STACK, refDomain: "Bad Domain" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    // Reserved migration domains are readable.
    await expect(listRootDomainRefs({ db: db!, stackId: STACK, refDomain: "_legacy" })).resolves.toMatchObject({ refs: [] });
  });
});

describe("listRootDomainEvents", () => {
  test("pages are revision-ordered with exclusive after and consistent latestRevision", async () => {
    await createStore();
    await seedEvent(1, "tenant-a", "r1", { [H1]: 1 });
    await seedEvent(2, "tenant-b", "r2", { [H2]: -1 });
    await seedEvent(3, "tenant-a", "r3", { [H1]: -1 });
    const page = await listRootDomainEvents({ db: db!, stackId: STACK, refDomain: DOMAIN, after: 1, limit: 1 });
    expect(page.latestRevision).toBe(3);
    expect(page.events).toEqual([{
      revision: 2,
      tenantId: "tenant-b",
      requestId: "r2",
      changes: { [H2]: -1 },
      appliedAt: 2000,
    }]);
    expect(page.nextAfter).toBe(2);
    const second = await listRootDomainEvents({ db: db!, stackId: STACK, refDomain: DOMAIN, after: page.nextAfter, limit: 1 });
    expect(second.events).toEqual([expect.objectContaining({ revision: 3, requestId: "r3" })]);
    expect(second.nextAfter).toBe(3);
  });

  test("an empty tenant-filtered page advances to the stack-domain watermark", async () => {
    await createStore();
    await seedEvent(1, "tenant-a", "r1", { [H1]: 1 });
    await seedEvent(2, "tenant-a", "r2", { [H1]: 1 });
    await seedEvent(3, "tenant-a", "r3", { [H1]: 1 });
    // Poll a tenant with no events: the page is empty but nextAfter must be
    // the watermark (3), not max(after, 0) = after, so polling never sticks.
    const empty = await listRootDomainEvents({ db: db!, stackId: STACK, refDomain: DOMAIN, tenantId: "tenant-b", after: 0 });
    expect(empty.events).toEqual([]);
    expect(empty.latestRevision).toBe(3);
    expect(empty.nextAfter).toBe(3);
  });

  test("after must be a non-negative safe integer", async () => {
    await createStore();
    await expect(listRootDomainEvents({ db: db!, stackId: STACK, refDomain: DOMAIN, after: -1 }))
      .rejects.toMatchObject({ status: 400 });
    await expect(listRootDomainEvents({ db: db!, stackId: STACK, refDomain: DOMAIN, after: 1.5 }))
      .rejects.toMatchObject({ status: 400 });
  });

  test("idempotent retries never duplicate events", async () => {
    await createStore();
    await db!.prepare(
      "INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at, child_ref_count, root_ref_count) VALUES (?, ?, ?, 10, 'text/plain', 1, 1, 0, 0)",
    ).bind(STACK, "tenant-a", H1).run();
    await bucket!.put(stackNodeKey(STACK, "tenant-a", H1), new TextEncoder().encode("content"));
    const canonical = await canonicalizeRootRefsUpdate({ requestId: "dup", changes: { [H1]: 1 }, refDomain: DOMAIN });
    for (let i = 0; i < 2; i += 1) {
      await executeDomainUpdate({
        db: db!,
        bucket: bucket!,
        stackId: STACK,
        tenantId: "tenant-a",
        refDomain: DOMAIN,
        canonical,
      });
    }
    const page = await listRootDomainEvents({ db: db!, stackId: STACK, refDomain: DOMAIN });
    expect(page.events).toHaveLength(1);
    expect(page.latestRevision).toBe(1);
  });
});

describe("audit read error shape", () => {
  test("errors carry the stable code and HTTP status", async () => {
    await createStore();
    try {
      await listRootDomainRefs({ db: db!, stackId: STACK, refDomain: "Bad Domain" });
      expect.fail("expected an error");
    } catch (error) {
      expect(error).toBeInstanceOf(AuditReadError);
      expect((error as AuditReadError).code).toBe("INVALID_REQUEST");
      expect((error as AuditReadError).status).toBe(400);
    }
  });
});
