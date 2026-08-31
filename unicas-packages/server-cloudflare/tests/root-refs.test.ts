import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { migrateStackTenantSchema } from "../src/schema.js";
import {
  canonicalizeRootRefsUpdate,
  executeDomainUpdate,
  parseRootRefsBody,
  withDomainRetry,
  RootRefsErrorCodes,
  RootRefsRetryableError,
  RootRefsValidationError,
} from "../src/root-refs.js";
import { stackCanonicalNodeKey } from "../src/do-names.js";

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
      name: "root-refs-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "root-refs-test-db" },
      r2Buckets: { BUCKET: "root-refs-test-bucket" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "root-refs-test");
  bucket = await miniflare.getR2Bucket("BUCKET", "root-refs-test");
  await migrateStackTenantSchema(db);
}

const STACK = "cas_stack_a";
const TENANT = "tenant-1";
const DOMAIN = "doc";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);

async function seedNode(hash: string, rootRefCount = 0, ready = true): Promise<void> {
  await db!.prepare(
    "INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at, child_ref_count, root_ref_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
  ).bind(STACK, TENANT, hash, 10, "text/plain", ready ? 1 : 0, ready ? 1 : 0, rootRefCount).run();
  if (ready) {
    await bucket!.put(stackCanonicalNodeKey(STACK, TENANT, hash), new TextEncoder().encode("content"));
  }
}

async function runUpdate(input: {
  requestId: string;
  changes: Record<string, number>;
  tenantId?: string;
  refDomain?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const canonical = await canonicalizeRootRefsUpdate({
      requestId: input.requestId,
      changes: input.changes,
      refDomain: input.refDomain ?? DOMAIN,
    });
    const result = await executeDomainUpdate({
      db: db!,
      bucket: bucket!,
      stackId: STACK,
      tenantId: input.tenantId ?? TENANT,
      refDomain: input.refDomain ?? DOMAIN,
      canonical,
    });
    return { status: 200, body: { success: true, idempotent: result.idempotent, revision: result.revision } };
  } catch (error) {
    if (error instanceof RootRefsValidationError) {
      return { status: error.status, body: { error: error.code, message: error.message } };
    }
    throw error;
  }
}

async function eventCount(): Promise<number> {
  const row = await db!.prepare(
    "SELECT COUNT(*) AS count FROM cas_root_domain_events WHERE stack_id = ? AND ref_domain = ?",
  ).bind(STACK, DOMAIN).first<{ count: number }>();
  return row?.count ?? 0;
}

async function aggregate(hash: string): Promise<number> {
  const row = await db!.prepare(
    "SELECT root_ref_count FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
  ).bind(STACK, TENANT, hash).first<{ root_ref_count: number }>();
  return row?.root_ref_count ?? -1;
}

describe("atomic Root Refs update", () => {
  test("applies deltas, appends one event, updates projection and idempotency", async () => {
    await createStore();
    await seedNode(H1, 3);
    await seedNode(H2, 1);
    const result = await runUpdate({
      requestId: "session:s1:commit:1",
      changes: { [H1]: 1, [H2]: -1 },
    });
    expect(result).toMatchObject({ status: 200, body: { success: true, idempotent: false, revision: 1 } });
    expect(await aggregate(H1)).toBe(4);
    expect(await aggregate(H2)).toBe(0);
    expect(await eventCount()).toBe(1);
    const projection = await db!.prepare(
      "SELECT hash, ref_count FROM cas_root_domain_refs WHERE stack_id = ? AND ref_domain = ? AND tenant_id = ? ORDER BY hash",
    ).bind(STACK, DOMAIN, TENANT).all<{ hash: string; ref_count: number }>();
    // The projection starts at zero (pre-existing aggregates have no domain
    // attribution): H1 +1 -> 1, H2 -1 -> -1 (negative balances kept).
    expect(projection.results).toEqual([
      { hash: H1, ref_count: 1 },
      { hash: H2, ref_count: -1 },
    ]);
    const idem = await db!.prepare(
      "SELECT revision, payload_hash FROM cas_root_ref_requests WHERE stack_id = ? AND tenant_id = ? AND ref_domain = ? AND request_id = ?",
    ).bind(STACK, TENANT, DOMAIN, "session:s1:commit:1").first<{ revision: number; payload_hash: string }>();
    expect(idem?.revision).toBe(1);
    expect(idem?.payload_hash).toHaveLength(64);
  }, 10_000);

  test("idempotent retries return the original revision and mutate nothing", async () => {
    await createStore();
    await seedNode(H1, 3);
    const first = await runUpdate({ requestId: "r1", changes: { [H1]: 1 } });
    expect(first.body.revision).toBe(1);
    const second = await runUpdate({ requestId: "r1", changes: { [H1]: 1 } });
    expect(second).toMatchObject({ status: 200, body: { success: true, idempotent: true, revision: 1 } });
    expect(await aggregate(H1)).toBe(4); // applied once
    expect(await eventCount()).toBe(1);
  });

  test("requestId reuse with a different payload conflicts", async () => {
    await createStore();
    await seedNode(H1, 3);
    await runUpdate({ requestId: "r1", changes: { [H1]: 1 } });
    const conflict = await runUpdate({ requestId: "r1", changes: { [H1]: 2 } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe(RootRefsErrorCodes.IDEMPOTENCY_CONFLICT);
  });

  test("validation: unknown hash, negative aggregate, zero delta, oversized delta", async () => {
    await createStore();
    await seedNode(H1, 1);
    await seedNode(H2, 0);

    const unknown = await runUpdate({ requestId: "u1", changes: { [H3]: 1 } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe(RootRefsErrorCodes.NODE_NOT_FOUND);

    const negative = await runUpdate({ requestId: "u2", changes: { [H2]: -1 } });
    expect(negative.status).toBe(409);
    expect(negative.body.error).toBe(RootRefsErrorCodes.NEGATIVE_AGGREGATE);

    const zero = await runUpdate({ requestId: "u3", changes: { [H1]: 0 } });
    expect(zero.status).toBe(400);

    const oversized = await runUpdate({ requestId: "u4", changes: { [H1]: 2_000_000 } });
    expect(oversized.status).toBe(400);

    const empty = await runUpdate({ requestId: "u5", changes: {} });
    expect(empty.status).toBe(400);

    // None of the rejected requests created events or idempotency rows.
    expect(await eventCount()).toBe(0);
    const idem = await db!.prepare("SELECT COUNT(*) AS count FROM cas_root_ref_requests").first<{ count: number }>();
    expect(idem?.count).toBe(0);
  });

  test("positive targets must be ready; non-ready is rejected", async () => {
    await createStore();
    await seedNode(H1, 0, false); // row exists, no R2 content
    const notReady = await runUpdate({ requestId: "r1", changes: { [H1]: 1 } });
    expect(notReady.status).toBe(409);
    expect(notReady.body.error).toBe(RootRefsErrorCodes.NODE_NOT_READY);
  });

  test("positive root refs accept canonical-v1 nodes", async () => {
    await createStore();
    await seedNode(H1, 0, true, 2);
    const result = await runUpdate({ requestId: "canonical", changes: { [H1]: 1 } });
    expect(result.status).toBe(200);
    expect(await aggregate(H1)).toBe(1);
  });

  test("negative domain balances are allowed while the aggregate stays valid", async () => {
    await createStore();
    await seedNode(H1, 2);
    await seedNode(H2, 5);
    // Establish a domain balance of +5 on H2, then release 7: aggregate 5-7 = -2? no — aggregate H2 is 5, release 7 → -2 < 0 rejected. So first grow the aggregate.
    await runUpdate({ requestId: "grow", changes: { [H2]: 3 } }); // aggregate 8
    const release = await runUpdate({ requestId: "release", changes: { [H2]: -7 } });
    expect(release.status).toBe(200);
    expect(await aggregate(H2)).toBe(1); // 8 - 7
    const projection = await db!.prepare(
      "SELECT ref_count FROM cas_root_domain_refs WHERE stack_id = ? AND ref_domain = ? AND tenant_id = ? AND hash = ?",
    ).bind(STACK, DOMAIN, TENANT, H2).first<{ ref_count: number }>();
    expect(projection?.ref_count).toBe(-4); // domain balance went negative (3 - 7)
  });

  test("revisions are monotonic per domain and independent across domains", async () => {
    await createStore();
    await seedNode(H1, 0);
    await seedNode(H2, 0);
    await db!.prepare(
      "INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at, child_ref_count, root_ref_count) VALUES (?, 'tenant-2', ?, 10, 'text/plain', 1, 1, 0, 0)",
    ).bind(STACK, H1).run();
    await bucket!.put(stackCanonicalNodeKey(STACK, "tenant-2", H1), new TextEncoder().encode("content"));

    // tenant-1 then tenant-2 in the same domain: revisions 1, 2.
    const a = await runUpdate({ requestId: "a", changes: { [H1]: 1 } });
    const b = await runUpdate({ requestId: "b", changes: { [H1]: 1 }, tenantId: "tenant-2" });
    expect(a.body.revision).toBe(1);
    expect(b.body.revision).toBe(2);

    // A different domain starts its own revision sequence.
    const c = await runUpdate({ requestId: "c", changes: { [H2]: 1 }, refDomain: "asset" });
    expect(c.body.revision).toBe(1);
  });

  test("validation never reads the audit event log", async () => {
    await createStore();
    await seedNode(H1, 1);
    const queries: string[] = [];
    const loggingDb = new Proxy(db!, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            queries.push(sql);
            return Reflect.get(target, prop, receiver).call(target, sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const canonical = await canonicalizeRootRefsUpdate({ requestId: "q1", changes: { [H1]: 1 }, refDomain: DOMAIN });
    await executeDomainUpdate({
      db: loggingDb,
      bucket: bucket!,
      stackId: STACK,
      tenantId: TENANT,
      refDomain: DOMAIN,
      canonical,
    });
    const reads = queries.filter((sql) => /^\s*SELECT/i.test(sql));
    expect(reads.every((sql) => !sql.includes("cas_root_domain_events"))).toBe(true);
    expect(reads.some((sql) => sql.includes("cas_nodes"))).toBe(true);
  });
});

describe("retry policy", () => {
  test("a revision-allocation conflict is retried with backoff and succeeds", async () => {
    await createStore();
    await seedNode(H1, 1);
    let conflictInjected = false;
    const wrappingDb = new Proxy(db!, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: unknown[]) => {
            if (!conflictInjected) {
              conflictInjected = true;
              // Simulate the revision CAS losing the conflict WITHOUT the
              // transaction committing: return 0 changes for the CAS
              // statement; the whole batch aborts (real D1 atomicity).
              return [{ meta: { changes: 0 } }, ...statements.slice(1).map(() => ({ meta: { changes: 1 } }))];
            }
            return Reflect.get(target, prop, receiver).call(target, statements);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const canonical = await canonicalizeRootRefsUpdate({ requestId: "conflict", changes: { [H1]: 1 }, refDomain: DOMAIN });
    const result = await withDomainRetry(
      () => executeDomainUpdate({
        db: wrappingDb,
        bucket: bucket!,
        stackId: STACK,
        tenantId: TENANT,
        refDomain: DOMAIN,
        canonical,
      }),
      { maxAttempts: 3, sleep: async () => undefined },
    );
    expect(result).toEqual({ idempotent: false, revision: 1 });
    expect(await aggregate(H1)).toBe(2);
  });

  test("a transient batch failure is retried and then succeeds", async () => {
    await createStore();
    await seedNode(H1, 1);
    let failures = 1;
    const flakyDb = new Proxy(db!, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: unknown[]) => {
            if (failures > 0) {
              failures -= 1;
              throw new Error("transient D1 failure");
            }
            return Reflect.get(target, prop, receiver).call(target, statements);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const canonical = await canonicalizeRootRefsUpdate({ requestId: "flaky", changes: { [H1]: 1 }, refDomain: DOMAIN });
    const result = await withDomainRetry(
      () => executeDomainUpdate({
        db: flakyDb,
        bucket: bucket!,
        stackId: STACK,
        tenantId: TENANT,
        refDomain: DOMAIN,
        canonical,
      }),
      { maxAttempts: 3, sleep: async () => undefined },
    );
    expect(result.revision).toBe(1);
  });

  test("bounded backoff exhaustion fails without partial mutation", async () => {
    await createStore();
    await seedNode(H1, 1);
    const brokenDb = new Proxy(db!, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async () => {
            throw new Error("D1 unavailable");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const canonical = await canonicalizeRootRefsUpdate({ requestId: "exhaust", changes: { [H1]: 1 }, refDomain: DOMAIN });
    let attempts = 0;
    await expect(withDomainRetry(
      () => {
        attempts += 1;
        return executeDomainUpdate({
          db: brokenDb,
          bucket: bucket!,
          stackId: STACK,
          tenantId: TENANT,
          refDomain: DOMAIN,
          canonical,
        });
      },
      { maxAttempts: 3, sleep: async () => undefined },
    )).rejects.toThrow(/D1 unavailable/);
    expect(attempts).toBe(3);
    expect(await aggregate(H1)).toBe(1); // untouched
    expect(await eventCount()).toBe(0);
  });

  test("duplicate JSON keys are rejected at parse", () => {
    const text = `{"requestId":"r","changes":{"${H1}":1,"${H1}":2}}`;
    expect(() => parseRootRefsBody(text)).toThrow(RootRefsValidationError);
  });
});
