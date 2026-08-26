import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { migrateStackTenantSchema } from "../src/schema.js";
import { canonicalizeRootRefsUpdate, executeDomainUpdate } from "../src/root-refs.js";
import worker from "../src/worker.js";
import type { Env } from "../src/worker.js";
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

const STACK = "cas_stack_a";
const DOMAIN = "doc";
const H1 = "a".repeat(64);
const READER_KEY = "audit-reader-secret";

async function createEnv(): Promise<Env> {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "audit-rpc-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "audit-rpc-test-db" },
      r2Buckets: { BUCKET: "audit-rpc-test-bucket" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "audit-rpc-test");
  bucket = await miniflare.getR2Bucket("BUCKET", "audit-rpc-test");
  await migrateStackTenantSchema(db);

  await db.prepare(
    "INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at, child_ref_count, root_ref_count) VALUES (?, 'tenant-a', ?, 10, 'text/plain', 1, 1, 0, 0)",
  ).bind(STACK, H1).run();
  await bucket.put(stackNodeKey(STACK, "tenant-a", H1), new TextEncoder().encode("content"));
  const canonical = await canonicalizeRootRefsUpdate({ requestId: "r1", changes: { [H1]: 1 }, refDomain: DOMAIN });
  await executeDomainUpdate({
    db,
    bucket,
    stackId: STACK,
    tenantId: "tenant-a",
    refDomain: DOMAIN,
    canonical,
  });

  return {
    CAS_CONTROL_DB: db,
    CAS_DB: db,
    CAS_R2: bucket,
    CAS_DO: {},
    CAS_DOMAIN_DO: {},
    CAS_AUDIT_READER_KEY: READER_KEY,
  } as unknown as Env;
}

function rpcRequest(path: string, key = READER_KEY): Request {
  const headers: Record<string, string> = {};
  if (key !== null) headers["X-CAS-Audit-Reader-Key"] = key;
  return new Request(`https://cas.example${path}`, { headers });
}

describe("audit-reader RPC", () => {
  test("refs RPC returns the current-balance page with the reader key", async () => {
    const env = await createEnv();
    const response = await worker.fetch(
      rpcRequest(`/_internal/audit/refs?stackId=${STACK}&refDomain=${DOMAIN}`),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { revision: number; refs: unknown[]; nextCursor: unknown };
    expect(body.revision).toBe(1);
    expect(body.refs).toEqual([{ tenantId: "tenant-a", hash: H1, count: 1 }]);
    expect(body.nextCursor).toBeNull();
  });

  test("events RPC returns the event log", async () => {
    const env = await createEnv();
    const response = await worker.fetch(
      rpcRequest(`/_internal/audit/events?stackId=${STACK}&refDomain=${DOMAIN}`),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { events: unknown[]; latestRevision: number; nextAfter: number };
    expect(body.latestRevision).toBe(1);
    expect(body.nextAfter).toBe(1);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ revision: 1, tenantId: "tenant-a", requestId: "r1" });
  });

  test("missing or wrong reader keys fail closed", async () => {
    const env = await createEnv();
    const noKey = await worker.fetch(rpcRequest(`/_internal/audit/refs?stackId=${STACK}&refDomain=${DOMAIN}`, ""), env);
    expect(noKey.status).toBe(404);
    const wrongKey = await worker.fetch(rpcRequest(`/_internal/audit/refs?stackId=${STACK}&refDomain=${DOMAIN}`, "wrong"), env);
    expect(wrongKey.status).toBe(404);
  });

  test("the RPC is disabled when no reader key is configured", async () => {
    const env = await createEnv();
    delete (env as { CAS_AUDIT_READER_KEY?: string }).CAS_AUDIT_READER_KEY;
    const response = await worker.fetch(rpcRequest(`/_internal/audit/refs?stackId=${STACK}&refDomain=${DOMAIN}`), env);
    expect(response.status).toBe(404);
  });

  test("the RPC only accepts GET", async () => {
    const env = await createEnv();
    const response = await worker.fetch(new Request(`https://cas.example/_internal/audit/refs?stackId=${STACK}&refDomain=${DOMAIN}`, {
      method: "POST",
      headers: { "X-CAS-Audit-Reader-Key": READER_KEY },
    }), env);
    expect(response.status).toBe(405);
  });

  test("validation errors surface with the stable audit codes", async () => {
    const env = await createEnv();
    const response = await worker.fetch(
      rpcRequest(`/_internal/audit/refs?stackId=${STACK}&refDomain=Bad%20Domain`),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });
});
