import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { migrateStackTenantSchema } from "../src/schema.js";
import { canonicalComposite, stackNodeKey } from "../src/do-names.js";
import { RootRefDomainDurableObject } from "../src/domain-do.js";
import type { RootRefDomainDoEnv } from "../src/domain-do.js";
import { CasDurableObject } from "../src/tenant-do.js";
import type { TenantCasDoEnv } from "../src/tenant-do.js";
import { RootRefsErrorCodes } from "../src/root-refs.js";

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
      name: "do-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "do-test-db" },
      r2Buckets: { BUCKET: "do-test-bucket" },
    }],
  }));
  await miniflare.ready;
  db = await miniflare.getD1Database("DB", "do-test");
  bucket = await miniflare.getR2Bucket("BUCKET", "do-test");
  await migrateStackTenantSchema(db);
}

const STACK = "cas_stack_a";
const TENANT = "tenant-1";
const DOMAIN = "doc";
const H1 = "a".repeat(64);

async function seedNode(hash: string): Promise<void> {
  await db!.prepare(
    "INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at, child_ref_count, root_ref_count) VALUES (?, ?, ?, 10, 'text/plain', 1, 1, 0, 1)",
  ).bind(STACK, TENANT, hash).run();
  await bucket!.put(stackNodeKey(STACK, TENANT, hash), new TextEncoder().encode("content"));
}

function domainCommand(requestId: string, changes: Record<string, number>): Request {
  return new Request("https://domain.internal/update", {
    method: "POST",
    headers: {
      "X-CAS-Stack-Id": STACK,
      "X-CAS-Tenant-Id": TENANT,
      "X-CAS-Ref-Domain": DOMAIN,
    },
    body: JSON.stringify({ requestId, changes }),
  });
}

describe("RootRefDomainDurableObject", () => {
  test("executes the atomic update and returns the revision", async () => {
    await createStore();
    await seedNode(H1);
    const doInstance = new RootRefDomainDurableObject(
      {} as DurableObjectState,
      { CAS_DB: db!, CAS_R2: bucket! } as RootRefDomainDoEnv,
    );
    const response = await doInstance.fetch(domainCommand("r1", { [H1]: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, idempotent: false, revision: 1 });
  });

  test("rejects commands without the verified identity headers", async () => {
    await createStore();
    const doInstance = new RootRefDomainDurableObject(
      {} as DurableObjectState,
      { CAS_DB: db!, CAS_R2: bucket! } as RootRefDomainDoEnv,
    );
    const response = await doInstance.fetch(new Request("https://domain.internal/update", {
      method: "POST",
      body: JSON.stringify({ requestId: "r", changes: {} }),
    }));
    expect(response.status).toBe(400);
  });

  test("maps validation failures to stable error responses", async () => {
    await createStore();
    const doInstance = new RootRefDomainDurableObject(
      {} as DurableObjectState,
      { CAS_DB: db!, CAS_R2: bucket! } as RootRefDomainDoEnv,
    );
    const response = await doInstance.fetch(domainCommand("r1", { [H1]: 1 })); // no node
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: RootRefsErrorCodes.NODE_NOT_FOUND });
  });
});

describe("CasDurableObject (tenant DO)", () => {
  test("forwards ONE canonical command to the domain DO and passes the response through", async () => {
    await createStore();
    let forwarded: { name: string; headers: Headers; body: string } | undefined;
    const stubNamespace = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (_input: unknown, init?: RequestInit) => {
          forwarded = {
            name: id.name,
            headers: new Headers(init?.headers),
            body: String(init?.body ?? ""),
          };
          return new Response(JSON.stringify({ success: true, idempotent: false, revision: 7 }), {
            status: 200,
          });
        },
      }),
    };
    const doInstance = new CasDurableObject(
      {} as DurableObjectState,
      { CAS_DB: db!, CAS_R2: bucket!, CAS_DOMAIN_DO: stubNamespace as unknown as TenantCasDoEnv["CAS_DOMAIN_DO"] },
    );
    const response = await doInstance.fetch(new Request("https://tenant.internal/updateRootRefs", {
      method: "POST",
      headers: {
        "X-CAS-Stack-Id": STACK,
        "X-CAS-Tenant-Id": TENANT,
        "X-CAS-Ref-Domain": DOMAIN,
      },
      body: JSON.stringify({ requestId: "r1", changes: { [H1]: 1 } }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, idempotent: false, revision: 7 });
    expect(forwarded?.name).toBe(canonicalComposite(STACK, DOMAIN));
    expect(forwarded?.headers.get("X-CAS-Stack-Id")).toBe(STACK);
    expect(forwarded?.headers.get("X-CAS-Tenant-Id")).toBe(TENANT);
    expect(forwarded?.headers.get("X-CAS-Ref-Domain")).toBe(DOMAIN);
    const body = JSON.parse(forwarded!.body) as { requestId: string; changes: Record<string, number> };
    expect(body).toEqual({ requestId: "r1", changes: { [H1]: 1 } });
  });

  test("rejects duplicate JSON keys before forwarding", async () => {
    await createStore();
    let forwarded = false;
    const stubNamespace = {
      idFromName: () => ({ name: "x" }),
      get: () => ({
        fetch: async () => {
          forwarded = true;
          return new Response("{}", { status: 200 });
        },
      }),
    };
    const doInstance = new CasDurableObject(
      {} as DurableObjectState,
      { CAS_DB: db!, CAS_R2: bucket!, CAS_DOMAIN_DO: stubNamespace as unknown as TenantCasDoEnv["CAS_DOMAIN_DO"] },
    );
    const body = `{"requestId":"r","changes":{"${H1}":1,"${H1}":2}}`;
    const response = await doInstance.fetch(new Request("https://tenant.internal/updateRootRefs", {
      method: "POST",
      headers: { "X-CAS-Stack-Id": STACK, "X-CAS-Tenant-Id": TENANT, "X-CAS-Ref-Domain": DOMAIN },
      body,
    }));
    expect(response.status).toBe(400);
    expect(forwarded).toBe(false);
  });

  test("other tenant operations are not implemented yet", async () => {
    await createStore();
    const doInstance = new CasDurableObject(
      {} as DurableObjectState,
      { CAS_DB: db!, CAS_R2: bucket!, CAS_DOMAIN_DO: {} as TenantCasDoEnv["CAS_DOMAIN_DO"] },
    );
    const response = await doInstance.fetch(new Request("https://tenant.internal/read", {
      method: "GET",
      headers: { "X-CAS-Stack-Id": STACK, "X-CAS-Tenant-Id": TENANT },
    }));
    expect(response.status).toBe(501);
  });
});
