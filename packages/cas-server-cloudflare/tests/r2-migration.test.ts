import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { encodeHeader, hexToHash, computeNodeDigest, hashToHex } from "@unidocs/cas-server-common";
import { migrateStackTenantSchema } from "../src/schema.js";
import {
  deleteMigratedSources,
  discoverR2Sources,
  manifestStats,
  parseHistoricalNodeKey,
  runR2Migration,
  verifyR2Digests,
} from "../src/r2-migration.js";

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
      name: "r2-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "r2-test-db" },
      r2Buckets: { BUCKET: "r2-test-bucket" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "r2-test");
  bucket = await miniflare.getR2Bucket("BUCKET", "r2-test");
  await migrateStackTenantSchema(db);
}

async function seedCanonicalNode(
  content: Uint8Array,
  contentType: string,
  childHashes: readonly string[] = [],
): Promise<string> {
  const header = encodeHeader(content.length, contentType, childHashes.length);
  const digest = await computeNodeDigest(header, contentType, childHashes.map(hexToHash), content);
  return hashToHex(digest);
}

const STACK = "cas_legacy";

describe("R2 migration", () => {
  test("discovers both historical key formats and copies with size verification", async () => {
    await createStore();
    const contentA = new TextEncoder().encode("content-a");
    const hashA = await seedCanonicalNode(contentA, "text/plain");
    const contentB = new TextEncoder().encode("content-b");
    const hashB = await seedCanonicalNode(contentB, "text/plain");

    await bucket!.put(`users/tenant-x/nodes/${hashA}`, contentA, { httpMetadata: { contentType: "text/plain" } });
    await bucket!.put(`tenants/tenant-y/nodes/${hashB}`, contentB);

    const added = await discoverR2Sources({ db: db!, bucket: bucket!, legacyStackId: STACK });
    expect(added).toBe(2);
    const stats = await runR2Migration({ db: db!, bucket: bucket!, legacyStackId: STACK });
    expect(stats).toMatchObject({ total: 2, verified: 2, failed: 0, remaining: 0 });

    const destA = await bucket!.get(`stacks/${STACK}/tenants/tenant-x/nodes/${hashA}`);
    expect(destA).not.toBeNull();
    expect(destA!.size).toBe(contentA.length);
    const destB = await bucket!.get(`stacks/${STACK}/tenants/tenant-y/nodes/${hashB}`);
    expect(destB!.size).toBe(contentB.length);
    // Sources are never deleted during migration.
    expect(await bucket!.get(`users/tenant-x/nodes/${hashA}`)).not.toBeNull();
    expect(await bucket!.get(`tenants/tenant-y/nodes/${hashB}`)).not.toBeNull();
  });

  test("resumes after failure and retries within the attempt bound", async () => {
    await createStore();
    const content = new TextEncoder().encode("content");
    const hash = await seedCanonicalNode(content, "text/plain");
    await bucket!.put(`tenants/tenant-z/nodes/${hash}`, content);

    await discoverR2Sources({ db: db!, bucket: bucket!, legacyStackId: STACK });
    // First attempt: the source is missing (simulated outage) -> failed.
    await bucket!.delete(`tenants/tenant-z/nodes/${hash}`);
    const first = await runR2Migration({ db: db!, bucket: bucket!, legacyStackId: STACK });
    expect(first.failed).toBe(1);
    // Restore the source and rerun: the failed row is retried.
    await bucket!.put(`tenants/tenant-z/nodes/${hash}`, content);
    const second = await runR2Migration({ db: db!, bucket: bucket!, legacyStackId: STACK });
    expect(second.verified).toBe(1);
    expect(second.failed).toBe(0);
  });

  test("digest pass verifies canonical content when metadata is available", async () => {
    await createStore();
    const contentType = "text/markdown";
    const child = await seedCanonicalNode(new TextEncoder().encode("child"), "text/plain");
    const content = new TextEncoder().encode("parent");
    const hash = await seedCanonicalNode(content, contentType, [child]);
    await bucket!.put(`tenants/tenant-d/nodes/${hash}`, content);

    await runR2Migration({ db: db!, bucket: bucket!, legacyStackId: STACK });
    const metadata = new Map([[hash, { contentType, childHashes: [child] }]]);
    const digest = await verifyR2Digests({
      db: db!,
      bucket: bucket!,
      legacyStackId: STACK,
      nodeMetadata: async (tenantId, h) => (tenantId === "tenant-d" ? metadata.get(h) ?? null : null),
    });
    expect(digest.verified).toBe(1);
    expect(digest.mismatched).toBe(0);
  });

  test("digest mismatch marks the row failed; deletion refuses while incomplete", async () => {
    await createStore();
    const content = new TextEncoder().encode("content");
    const hash = await seedCanonicalNode(content, "text/plain");
    await bucket!.put(`tenants/tenant-e/nodes/${hash}`, content);

    await runR2Migration({ db: db!, bucket: bucket!, legacyStackId: STACK });
    const digest = await verifyR2Digests({
      db: db!,
      bucket: bucket!,
      legacyStackId: STACK,
      // Deliberately wrong content type -> reconstructed digest mismatches.
      nodeMetadata: async () => ({ contentType: "text/html", childHashes: [] }),
    });
    expect(digest.mismatched).toBe(1);

    await expect(deleteMigratedSources({ db: db!, bucket: bucket!, legacyStackId: STACK }))
      .rejects.toThrow(/incomplete/);
    expect((await manifestStats(db!)).failed).toBe(1);
  });

  test("post-contract deletion removes sources only when the manifest is complete", async () => {
    await createStore();
    const content = new TextEncoder().encode("content");
    const hash = await seedCanonicalNode(content, "text/plain");
    await bucket!.put(`users/tenant-f/nodes/${hash}`, content);
    await runR2Migration({ db: db!, bucket: bucket!, legacyStackId: STACK });
    expect((await manifestStats(db!)).remaining).toBe(0);

    const deleted = await deleteMigratedSources({ db: db!, bucket: bucket!, legacyStackId: STACK });
    expect(deleted).toBe(1);
    expect(await bucket!.get(`users/tenant-f/nodes/${hash}`)).toBeNull();
  });

  test("malformed or foreign keys are ignored", () => {
    expect(parseHistoricalNodeKey("users/u/nodes/h")).toEqual({ tenantId: "u", hash: "h" });
    expect(parseHistoricalNodeKey("tenants/u/nodes/h")).toEqual({ tenantId: "u", hash: "h" });
    expect(parseHistoricalNodeKey("other/u/nodes/h")).toBeNull();
    expect(parseHistoricalNodeKey("users/u/blobs/h")).toBeNull();
    expect(parseHistoricalNodeKey("users/u/nodes/")).toBeNull();
    expect(parseHistoricalNodeKey("")).toBeNull();
  });
});
