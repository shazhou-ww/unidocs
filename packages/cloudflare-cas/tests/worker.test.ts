import { describe, it, expect, vi } from "vitest";
import worker from "../src/worker";

const TOKEN = "test-internal-token";
const hash = "a".repeat(64);

function env(overrides: Record<string, unknown> = {}) {
  const doFetch = vi.fn(async () => Response.json({ success: true }));
  return {
    INTERNAL_AUTH_MODE: "legacy",
    CAS_ACCESS_KEY: TOKEN,
    CAS_DB: {
      exec: async () => undefined,
      prepare: () => ({
        all: async () => ({ results: [{ name: "tenant_id" }] }),
      }),
    },
    CAS_R2: {},
    CAS_DO: {
      idFromName: () => "id",
      get: () => ({ fetch: doFetch }),
    },
    doFetch,
    ...overrides,
  };
}

describe("CAS worker auth", () => {
  it("rejects missing internal token with 401", async () => {
    const res = await worker.fetch(
      new Request("https://cas/tenants/tenant-a/cas/usage"),
      env() as never,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a wrong internal token with 401", async () => {
    const res = await worker.fetch(
      new Request("https://cas/tenants/tenant-a/cas/usage", {
        headers: { "X-Internal-Token": "nope" },
      }),
      env() as never,
    );
    expect(res.status).toBe(401);
  });
});

describe("CAS worker root-refs", () => {
  it("requires X-Tenant-Id", async () => {
    const res = await worker.fetch(
      new Request("https://cas/_internal/root-refs", {
        method: "POST",
        headers: { "X-Internal-Token": TOKEN },
      }),
      env() as never,
    );
    expect(res.status).toBe(401);
  });

  it("forwards POST /_internal/root-refs to the Durable Object", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request("https://cas/_internal/root-refs", {
        method: "POST",
        headers: {
          "X-Internal-Token": TOKEN,
          "X-Tenant-Id": "tenant-a",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestId: "apply:session-a:2", changes: { [hash]: 1 } }),
      }),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    expect(bindings.doFetch).toHaveBeenCalled();
    const [url, init] = bindings.doFetch.mock.calls[0] as [string, { headers: Headers }];
    expect(new URL(url).pathname).toBe("/updateRootRefs");
    expect(init.headers.get("X-Tenant-Id")).toBe("tenant-a");
  });

  it("forwards POST /_internal/root-assignments to the Durable Object", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request("https://cas/_internal/root-assignments", {
        method: "POST",
        headers: {
          "X-Internal-Token": TOKEN,
          "X-Tenant-Id": "tenant-a",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "doc:d:delta:1",
          assignments: [{ owner: "doc:d:delta:1", hash }],
        }),
      }),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    const [url, init] = bindings.doFetch.mock.calls[0] as [string, { headers: Headers }];
    expect(new URL(url).pathname).toBe("/assignRoots");
    expect(init.headers.get("X-Tenant-Id")).toBe("tenant-a");
  });
});

describe("CAS worker full-node reads", () => {
  it("forwards an authenticated internal node read", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request(`https://cas/_internal/nodes/${hash}`, {
        headers: {
          "X-Internal-Token": TOKEN,
          "X-Tenant-Id": "tenant-a",
        },
      }),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    const [url, init] = bindings.doFetch.mock.calls[0] as [string, { headers: Headers }];
    expect(new URL(url).pathname).toBe("/readNode");
    expect(init.headers.get("X-CAS-Hash")).toBe(hash);
  });

  it("forwards an authenticated portable node upload", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request(`https://cas/_internal/nodes/${hash}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.unidocs.cas-node",
          "X-Internal-Token": TOKEN,
          "X-Tenant-Id": "tenant-a",
        },
        body: new Uint8Array([1]),
      }),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    const [url] = bindings.doFetch.mock.calls[0] as [string];
    expect(new URL(url).pathname).toBe("/leasePortableNode");
  });
});
