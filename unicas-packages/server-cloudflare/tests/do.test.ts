import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import {
  CanonicalNodeContentType,
  computeNodeDigest,
  concatenateNodeBytes,
  encodeHeader,
  hashToHex,
  hexToHash,
} from "@unicas/codec";
import { migrateStackTenantSchema } from "../src/schema.js";
import { canonicalComposite, stackCanonicalNodeKey } from "../src/do-names.js";
import { RootRefDomainDurableObject } from "../src/domain-do.js";
import type { RootRefDomainDoEnv } from "../src/domain-do.js";
import { CasDurableObject } from "../src/tenant-do.js";
import type { TenantCasDoEnv } from "../src/tenant-do.js";
import { RootRefsErrorCodes } from "../src/root-refs.js";
import { NodeOpErrorCodes, leaseCanonicalNode } from "../src/nodes.js";
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
      script: `export default {
        async fetch(request, env) {
          if (new URL(request.url).pathname !== "/r2-stream-probe") return new Response("ok");
          try {
            await env.BUCKET.put("stream-probe", request.body, {
              sha256: request.headers.get("X-Expected-Hash"),
            });
            return new Response("ok");
          } catch (error) {
            return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
          }
        }
      };`,
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
  await bucket!.put(stackCanonicalNodeKey(STACK, TENANT, hash), new TextEncoder().encode("content"));
}

async function leaseNode(store: NodeStore, input: {
  hash: string;
  contentType: string;
  refs: readonly string[];
  leaseDurationMs: number;
  content: Uint8Array;
}): Promise<unknown> {
  const children = input.refs.map(hexToHash);
  const canonical = concatenateNodeBytes(
    encodeHeader(input.content.length, input.contentType, children.length),
    new TextEncoder().encode(input.contentType),
    children,
    input.content,
  );
  return leaseCanonicalNode({ ...store, bucket: nodeHostedStreamBucket() }, {
    hash: input.hash,
    leaseDurationMs: input.leaseDurationMs,
    declaredLength: canonical.length,
    body: new Response(canonical).body!,
  });
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

function tenantDo(bucketOverride: R2Bucket = bucket!): CasDurableObject {
  return new CasDurableObject(
    {} as DurableObjectState,
    { CAS_DB: db!, CAS_R2: bucketOverride, CAS_DOMAIN_DO: {} as TenantCasDoEnv["CAS_DOMAIN_DO"] },
  );
}

function nodeHostedStreamBucket(): R2Bucket {
  const target = bucket!;
  return new Proxy(target, {
    get(_target, property) {
      if (property === "put") {
        return async (key: string, value: unknown, options?: R2PutOptions) => {
          const stored = value instanceof ReadableStream
            ? await new Response(value).arrayBuffer()
            : value;
          return target.put(
            key,
            stored as Parameters<R2Bucket["put"]>[1],
            options,
          );
        };
      }
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
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
  test("workerd streams a known-length request body to R2 with SHA-256 verification", async () => {
    await createStore();
    const content = new TextEncoder().encode("workerd stream");
    const hash = hashToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));
    const response = await miniflare!.dispatchFetch("http://probe/r2-stream-probe", {
      method: "POST",
      headers: {
        "Content-Length": String(content.length),
        "X-Expected-Hash": hash,
      },
      body: content,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(new Uint8Array(await (await bucket!.get("stream-probe"))!.arrayBuffer())).toEqual(content);
  });

  test("unified lease streams a complete canonical node to R2 and reads only own content", async () => {
    await createStore();
    const content = new TextEncoder().encode("canonical payload");
    const contentType = "application/octet-stream";
    const header = encodeHeader(content.length, contentType, 0);
    const canonical = concatenateNodeBytes(header, new TextEncoder().encode(contentType), [], content);
    const hash = hashToHex(await crypto.subtle.digest("SHA-256", canonical).then(value => new Uint8Array(value)));
    const doInstance = tenantDo(nodeHostedStreamBucket());

    const lease = await doInstance.fetch(tenantRequest("/lease", "POST", {
      "X-CAS-Hash": hash,
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(canonical.length),
    }, canonical));
    const leaseText = await lease.text();
    expect(lease.status, leaseText).toBe(200);
    expect(JSON.parse(leaseText)).toMatchObject({ hash, ready: true });

    const stored = await bucket!.get(stackCanonicalNodeKey(STACK, TENANT, hash));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(canonical);
    const read = await doInstance.fetch(tenantRequest("/read", "GET", { "X-CAS-Hash": hash }));
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(content);

    const renewed = await doInstance.fetch(tenantRequest("/lease", "POST", {
      "X-CAS-Hash": hash,
      "X-CAS-Lease-Duration": "180000",
    }));
    expect(renewed.status).toBe(200);
  });

  test("canonical node reads apply HTTP ranges to own content", async () => {
    await createStore();
    const content = new TextEncoder().encode("0123456789");
    const contentType = "text/plain";
    const header = encodeHeader(content.length, contentType, 0);
    const canonical = concatenateNodeBytes(header, new TextEncoder().encode(contentType), [], content);
    const hash = hashToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", canonical)));
    const doInstance = tenantDo(nodeHostedStreamBucket());
    const lease = await doInstance.fetch(tenantRequest("/lease", "POST", {
      "X-CAS-Hash": hash,
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(canonical.length),
    }, canonical));
    expect(lease.status).toBe(200);

    const middle = await doInstance.fetch(tenantRequest("/read", "GET", {
      "X-CAS-Hash": hash,
      Range: "bytes=2-5",
    }));
    expect(middle.status).toBe(206);
    expect(middle.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(await middle.text()).toBe("2345");

    const suffix = await doInstance.fetch(tenantRequest("/read", "GET", {
      "X-CAS-Hash": hash,
      Range: "bytes=-3",
    }));
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("789");

    const unsatisfiable = await doInstance.fetch(tenantRequest("/read", "GET", {
      "X-CAS-Hash": hash,
      Range: "bytes=10-",
    }));
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("Content-Range")).toBe("bytes */10");
  });

  test("unified lease digest failures leave no object or reservation", async () => {
    await createStore();
    const content = new TextEncoder().encode("wrong hash");
    const contentType = "text/plain";
    const canonical = concatenateNodeBytes(
      encodeHeader(content.length, contentType, 0),
      new TextEncoder().encode(contentType),
      [],
      content,
    );
    const doInstance = tenantDo(nodeHostedStreamBucket());
    const response = await doInstance.fetch(tenantRequest("/lease", "POST", {
      "X-CAS-Hash": H1,
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(canonical.length),
    }, canonical));
    expect(response.status).toBe(400);
    expect(await bucket!.head(stackCanonicalNodeKey(STACK, TENANT, H1))).toBeNull();
    const reservation = await db!.prepare(
      "SELECT COUNT(*) AS count FROM cas_upload_reservations WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(STACK, TENANT, H1).first<{ count: number }>();
    expect(reservation?.count).toBe(0);
  });

  test("no-body lease adopts a verified canonical R2 orphan", async () => {
    await createStore();
    const content = new TextEncoder().encode("orphan");
    const contentType = "text/plain";
    const canonical = concatenateNodeBytes(
      encodeHeader(content.length, contentType, 0),
      new TextEncoder().encode(contentType),
      [],
      content,
    );
    const hash = hashToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", canonical)));
    await bucket!.put(stackCanonicalNodeKey(STACK, TENANT, hash), canonical, { sha256: hash });

    const response = await tenantDo().fetch(tenantRequest("/lease", "POST", {
      "X-CAS-Hash": hash,
    }));
    expect(response.status).toBe(200);
    const row = await db!.prepare(
      "SELECT content_size FROM cas_nodes WHERE stack_id = ? AND tenant_id = ? AND hash = ?",
    ).bind(STACK, TENANT, hash).first<{ content_size: number }>();
    expect(row).toEqual({ content_size: content.length });
  });

  test("canonical lease stores content and records edges; read/metadata/usage round-trip", async () => {
    await createStore();
    const childContent = "child";
    const childHash = await digestOf(childContent);
    await leaseNode(store(), {
      hash: childHash,
      contentType: "text/plain",
      refs: [],
      leaseDurationMs: 60_000,
      content: new TextEncoder().encode(childContent),
    });
    const parentContent = "parent";
    const hash = await digestOf(parentContent, "text/plain", [childHash]);
    const doInstance = tenantDo(nodeHostedStreamBucket());
    const parentBytes = new TextEncoder().encode(parentContent);
    const children = [hexToHash(childHash)];
    const canonical = concatenateNodeBytes(
      encodeHeader(parentBytes.length, "text/plain", children.length),
      new TextEncoder().encode("text/plain"),
      children,
      parentBytes,
    );
    const lease = await doInstance.fetch(tenantRequest("/lease", "POST", {
      "X-CAS-Hash": hash,
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(canonical.length),
      "X-CAS-Lease-Duration": "120000",
    }, canonical));
    expect(lease.status).toBe(200);
    const leaseBody = await lease.json();
    expect(leaseBody).toMatchObject({ hash, ready: true });
    expect((await bucket!.head(stackCanonicalNodeKey(STACK, TENANT, hash)))?.size).toBe(canonical.length);

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
      readyStoredBytes: expect.any(Number),
      reservedBytes: 0,
      notReadyNodeCount: 0,
      leasedNodeCount: 2,
    });
  });

  test("canonical lease rejects digest mismatches and missing children", async () => {
    await createStore();
    const doInstance = tenantDo(nodeHostedStreamBucket());
    const content = new TextEncoder().encode("mismatch");
    const wrongCanonical = concatenateNodeBytes(
      encodeHeader(content.length, "text/plain", 0),
      new TextEncoder().encode("text/plain"),
      [],
      content,
    );
    const wrong = await doInstance.fetch(tenantRequest("/lease", "POST", {
      "X-CAS-Hash": H1,
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(wrongCanonical.length),
    }, wrongCanonical));
    expect(wrong.status).toBe(400);
    await expect(wrong.json()).resolves.toMatchObject({ error: NodeOpErrorCodes.INVALID_REQUEST });

    // Child not ready → 409 before anything is written.
    const childHash = "e".repeat(64);
    const parentContent = "parent-with-child";
    const hash = await digestOf(parentContent, "text/plain", [childHash]);
    const missingBytes = new TextEncoder().encode(parentContent);
    const missingChildren = [hexToHash(childHash)];
    const missingCanonical = concatenateNodeBytes(
      encodeHeader(missingBytes.length, "text/plain", 1),
      new TextEncoder().encode("text/plain"),
      missingChildren,
      missingBytes,
    );
    const missingChild = await doInstance.fetch(tenantRequest("/lease", "POST", {
      "X-CAS-Hash": hash,
      "Content-Type": CanonicalNodeContentType,
      "Content-Length": String(missingCanonical.length),
    }, missingCanonical));
    expect(missingChild.status).toBe(409);
  });

  test("canonical lease honors stricter service limits", async () => {
    await createStore();
    const childContent = new TextEncoder().encode("child");
    const childHash = await digestOf("child");
    await leaseNode(store(), {
      hash: childHash,
      contentType: "text/plain",
      refs: [],
      leaseDurationMs: 60_000,
      content: childContent,
    });
    const parentContent = new TextEncoder().encode("parent");
    const header = encodeHeader(parentContent.length, "text/plain", 1);
    const children = [hexToHash(childHash)];
    const parentHash = hashToHex(await computeNodeDigest(header, "text/plain", children, parentContent));
    const canonical = concatenateNodeBytes(
      header,
      new TextEncoder().encode("text/plain"),
      children,
      parentContent,
    );
    const body = new Response(canonical).body!;

    await expect(leaseCanonicalNode(
      { ...store(), limits: { maxNodeRefs: 0 } },
      { hash: parentHash, leaseDurationMs: 60_000, body, declaredLength: canonical.length },
    )).rejects.toMatchObject({ status: 400, code: NodeOpErrorCodes.INVALID_REQUEST });
  });

  test("bodyless lease extends a ready lease and 404s missing nodes", async () => {
    await createStore();
    const content = "abc";
    const hash = await digestOf(content);
    await leaseNode(store(), {
      hash,
      contentType: "text/plain",
      refs: [],
      leaseDurationMs: 60_000,
      content: new TextEncoder().encode(content),
    });
    const doInstance = tenantDo(nodeHostedStreamBucket());
    const extended = await doInstance.fetch(tenantRequest("/lease", "POST", {
      "X-CAS-Hash": hash,
      "X-CAS-Lease-Duration": "180000",
    }));
    expect(extended.status).toBe(200);
    const body = await extended.json();
    expect(body).toMatchObject({ hash, ready: true });

    const missing = await doInstance.fetch(tenantRequest("/lease", "POST", {
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
    await bucket!.put(stackCanonicalNodeKey(STACK, TENANT, dead), new TextEncoder().encode("dead!"));

    const doInstance = tenantDo(nodeHostedStreamBucket());
    const gc = await doInstance.fetch(tenantRequest("/gc", "POST", {}, new TextEncoder().encode("{}")));
    expect(gc.status).toBe(200);
    await expect(gc.json()).resolves.toMatchObject({ examined: 1, deleted: 1, reclaimedContentBytes: 5 });

    expect(await bucket!.get(stackCanonicalNodeKey(STACK, TENANT, dead))).toBeNull();
    for (const content of ["keep", "held"]) {
      const hash = await digestOf(content);
      expect(await bucket!.get(stackCanonicalNodeKey(STACK, TENANT, hash))).not.toBeNull();
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
      refs: [],
      leaseDurationMs: 60_000,
      content: new TextEncoder().encode(content),
    });
    const doInstance = tenantDo(nodeHostedStreamBucket());

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
    expect(await bucket!.get(stackCanonicalNodeKey(STACK, TENANT, hash))).not.toBeNull();
  });
});
