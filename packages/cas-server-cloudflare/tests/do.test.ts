import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { computeNodeDigest, encodeHeader, hashToHex, hexToHash } from "@unidocs/cas-server-common";
import { createSBlob, encodeSValue } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import type { SValue } from "@unidocs/protocol";
import { migrateStackTenantSchema } from "../src/schema.js";
import { canonicalComposite, stackNodeKey } from "../src/do-names.js";
import { RootRefDomainDurableObject } from "../src/domain-do.js";
import type { RootRefDomainDoEnv } from "../src/domain-do.js";
import { CasDurableObject } from "../src/tenant-do.js";
import type { TenantCasDoEnv } from "../src/tenant-do.js";
import { RootRefsErrorCodes } from "../src/root-refs.js";
import { NodeOpErrorCodes, leaseNode } from "../src/nodes.js";
import type { NodeStore } from "../src/nodes.js";

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
});

async function digestOf(content: string, contentType = "text/plain", refs: readonly string[] = []): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const header = encodeHeader(bytes.length, contentType, refs.length);
  const digest = await computeNodeDigest(header, contentType, refs.map(hexToHash), bytes);
  return hashToHex(digest);
}

function tenantDo(): CasDurableObject {
  return new CasDurableObject(
    {} as DurableObjectState,
    { CAS_DB: db!, CAS_R2: bucket!, CAS_DOMAIN_DO: {} as TenantCasDoEnv["CAS_DOMAIN_DO"] },
  );
}

function store(): NodeStore {
  return { db: db!, bucket: bucket!, stackId: STACK, tenantId: TENANT };
}

function tenantRequest(path: string, method: string, headers: Record<string, string>, body?: Uint8Array): Request {
  return new Request(`https://tenant.internal${path}`, {
    method,
    headers: { "X-CAS-Stack-Id": STACK, "X-CAS-Tenant-Id": TENANT, ...headers },
    body: body as unknown as BodyInit | undefined,
  });
}

describe("CasDurableObject (tenant DO) — node storage operations", () => {
  test("leaseNode stores content and records edges; read/metadata/usage round-trip", async () => {
    await createStore();
    const childContent = "child";
    const childHash = await digestOf(childContent);
    await leaseNode(store(), {
      hash: childHash,
      contentType: "text/plain",
      contentLength: childContent.length,
      refs: [],
      leaseDurationMs: 60_000,
      content: new TextEncoder().encode(childContent),
    });
    const parentContent = "parent";
    const hash = await digestOf(parentContent, "text/plain", [childHash]);
    const doInstance = tenantDo();
    const lease = await doInstance.fetch(tenantRequest("/leaseNode", "POST", {
      "X-CAS-Hash": hash,
      "Content-Type": "text/plain",
      "X-CAS-Refs": childHash,
      "X-CAS-Lease-Duration": "120000",
    }, new TextEncoder().encode(parentContent)));
    expect(lease.status).toBe(200);
    const leaseBody = await lease.json();
    expect(leaseBody).toMatchObject({ hash, ready: true });
    expect((await bucket!.head(stackNodeKey(STACK, TENANT, hash)))?.size).toBe(parentContent.length);

    const read = await doInstance.fetch(tenantRequest("/read", "GET", { "X-CAS-Hash": hash }));
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new TextEncoder().encode(parentContent));

    const metadata = await doInstance.fetch(tenantRequest("/metadata", "GET", { "X-CAS-Hash": hash }));
    expect(metadata.status).toBe(200);
    const { metadata: meta, state } = await metadata.json();
    expect(meta).toMatchObject({ hash, size: parentContent.length, contentType: "text/plain", refs: [childHash] });
    expect(state.childRefCount).toBe(0);

    const childMeta = await doInstance.fetch(tenantRequest("/metadata", "GET", { "X-CAS-Hash": childHash }));
    const childBody = await childMeta.json();
    expect(childBody.state.childRefCount).toBe(1);

    const usageResponse = await doInstance.fetch(tenantRequest("/usage", "GET"));
    expect(usageResponse.status).toBe(200);
    const usageBody = await usageResponse.json();
    expect(usageBody).toMatchObject({
      nodeCount: 2,
      readyContentBytes: parentContent.length + childContent.length,
      notReadyNodeCount: 0,
      leasedNodeCount: 2,
    });
  });

  test("leaseNode rejects digest mismatches and missing children", async () => {
    await createStore();
    const doInstance = tenantDo();
    const content = new TextEncoder().encode("mismatch");
    const wrong = await doInstance.fetch(tenantRequest("/leaseNode", "POST", {
      "X-CAS-Hash": H1,
      "Content-Type": "text/plain",
    }, content));
    expect(wrong.status).toBe(400);
    await expect(wrong.json()).resolves.toMatchObject({ error: NodeOpErrorCodes.INVALID_REQUEST });

    // Child not ready → 409 before anything is written.
    const childHash = "e".repeat(64);
    const parentContent = "parent-with-child";
    const hash = await digestOf(parentContent, "text/plain", [childHash]);
    const missingChild = await doInstance.fetch(tenantRequest("/leaseNode", "POST", {
      "X-CAS-Hash": hash,
      "Content-Type": "text/plain",
      "X-CAS-Refs": childHash,
    }, new TextEncoder().encode(parentContent)));
    expect(missingChild.status).toBe(409);
  });

  test("leaseNode validates SValue refs against encoded content", async () => {
    await createStore();
    const blobContent = "blob";
    const blobHash = await digestOf(blobContent, "application/octet-stream");
    await leaseNode(store(), {
      hash: blobHash,
      contentType: "application/octet-stream",
      contentLength: blobContent.length,
      refs: [],
      leaseDurationMs: 60_000,
      content: new TextEncoder().encode(blobContent),
    });
    const value = { ops: [{ kind: "insertImage", blob: createSBlob(blobHash) }] };
    const bytes = encodeSValue(value as SValue);
    const header = encodeHeader(bytes.length, SValueContentType, 1);
    const digest = await computeNodeDigest(header, SValueContentType, [hexToHash(blobHash)], bytes);
    const hash = hashToHex(digest);
    const doInstance = tenantDo();

    const matching = await doInstance.fetch(tenantRequest("/leaseNode", "POST", {
      "X-CAS-Hash": hash,
      "Content-Type": SValueContentType,
      "X-CAS-Refs": blobHash,
    }, bytes));
    expect(matching.status).toBe(200);

    const mismatched = await doInstance.fetch(tenantRequest("/leaseNode", "POST", {
      "X-CAS-Hash": hash,
      "Content-Type": SValueContentType,
      "X-CAS-Refs": "0".repeat(64),
    }, bytes));
    expect(mismatched.status).toBe(400);
  });

  test("leaseExisting extends a ready lease and 404s missing nodes", async () => {
    await createStore();
    const content = "abc";
    const hash = await digestOf(content);
    await leaseNode(store(), {
      hash,
      contentType: "text/plain",
      contentLength: content.length,
      refs: [],
      leaseDurationMs: 60_000,
      content: new TextEncoder().encode(content),
    });
    const doInstance = tenantDo();
    const extended = await doInstance.fetch(tenantRequest("/leaseExisting", "POST", {
      "X-CAS-Hash": hash,
      "X-CAS-Lease-Duration": "180000",
    }));
    expect(extended.status).toBe(200);
    const body = await extended.json();
    expect(body).toMatchObject({ hash, ready: true });

    const missing = await doInstance.fetch(tenantRequest("/leaseExisting", "POST", {
      "X-CAS-Hash": "1".repeat(64),
    }));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: NodeOpErrorCodes.NOT_FOUND });
  });

  test("GC deletes unreferenced expired nodes but keeps referenced and leased nodes", async () => {
    await createStore();
    for (const content of ["keep", "held"]) {
      const hash = await digestOf(content);
      await leaseNode(store(), {
        hash,
        contentType: "text/plain",
        contentLength: content.length,
        refs: [],
        leaseDurationMs: 60_000,
        content: new TextEncoder().encode(content),
      });
    }
    // Unreferenced node with an expired lease (root_ref_count 0, lease in the past).
    const dead = "d".repeat(64);
    await db!.prepare(
      "INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at, child_ref_count, root_ref_count) VALUES (?, ?, ?, 5, 'text/plain', 1, 1, 0, 0)",
    ).bind(STACK, TENANT, dead).run();
    await bucket!.put(stackNodeKey(STACK, TENANT, dead), new TextEncoder().encode("dead!"));

    const doInstance = tenantDo();
    const gc = await doInstance.fetch(tenantRequest("/gc", "POST", {}, new TextEncoder().encode("{}")));
    expect(gc.status).toBe(200);
    await expect(gc.json()).resolves.toMatchObject({ examined: 1, deleted: 1, reclaimedContentBytes: 5 });

    expect(await bucket!.get(stackNodeKey(STACK, TENANT, dead))).toBeNull();
    for (const content of ["keep", "held"]) {
      const hash = await digestOf(content);
      expect(await bucket!.get(stackNodeKey(STACK, TENANT, hash))).not.toBeNull();
    }
  });

  test("nodes, leases, usage, and GC are isolated per stack for the same tenant id", async () => {
    await createStore();
    const otherStack = "cas_stack_b";
    const content = "stack-a";
    const hash = await digestOf(content);
    await leaseNode(store(), {
      hash,
      contentType: "text/plain",
      contentLength: content.length,
      refs: [],
      leaseDurationMs: 60_000,
      content: new TextEncoder().encode(content),
    });
    const doInstance = tenantDo();

    // Same tenant id under another stack: the node is invisible.
    const otherDo = new CasDurableObject(
      {} as DurableObjectState,
      { CAS_DB: db!, CAS_R2: bucket!, CAS_DOMAIN_DO: {} as TenantCasDoEnv["CAS_DOMAIN_DO"] },
    );
    const otherRead = await otherDo.fetch(new Request("https://tenant.internal/read", {
      method: "GET",
      headers: { "X-CAS-Stack-Id": otherStack, "X-CAS-Tenant-Id": TENANT, "X-CAS-Hash": hash },
    }));
    expect(otherRead.status).toBe(404);

    // Usage counts only the owning stack's nodes.
    const usageA = await doInstance.fetch(tenantRequest("/usage", "GET"));
    const usageB = await otherDo.fetch(new Request("https://tenant.internal/usage", {
      method: "GET",
      headers: { "X-CAS-Stack-Id": otherStack, "X-CAS-Tenant-Id": TENANT },
    }));
    expect((await usageA.json()).nodeCount).toBe(1);
    expect((await usageB.json()).nodeCount).toBe(0);

    // GC in the other stack must not delete this stack's unreferenced nodes.
    await db!.prepare(
      "INSERT INTO cas_nodes (stack_id, tenant_id, hash, content_size, content_type, lease_started_at, lease_expires_at, child_ref_count, root_ref_count) VALUES (?, ?, ?, 5, 'text/plain', 1, 1, 0, 0)",
    ).bind(otherStack, TENANT, "e".repeat(64)).run();
    const gcB = await otherDo.fetch(new Request("https://tenant.internal/gc", {
      method: "POST",
      headers: { "X-CAS-Stack-Id": otherStack, "X-CAS-Tenant-Id": TENANT },
      body: "{}",
    }));
    expect(gcB.status).toBe(200);
    expect(await bucket!.get(stackNodeKey(STACK, TENANT, hash))).not.toBeNull();
  });
});
