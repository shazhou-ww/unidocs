import { describe, it, expect } from "vitest";
import { CasBlobStore } from "../src/cas-blob-store.js";

function mockFetch(routes: Record<string, { status: number; body?: Uint8Array }>): typeof fetch {
  return (async (url: string) => {
    const r = routes[String(url)] ?? { status: 404 };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, arrayBuffer: async () => (r.body ?? new Uint8Array()).buffer } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("CasBlobStore.get", () => {
  it("GETs cas content and returns bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const s = new CasBlobStore({ apiBaseUrl: "/gw/tenants/u1", fetchImpl: mockFetch({ "/gw/tenants/u1/cas/nodes/abc/content": { status: 200, body: bytes } }) });
    expect([...(await s.get("abc"))!]).toEqual([1, 2, 3]);
  });
  it("returns null on 404", async () => {
    const s = new CasBlobStore({ apiBaseUrl: "/gw/tenants/u1", fetchImpl: mockFetch({}) });
    expect(await s.get("missing")).toBeNull();
  });

  it("uses the global fetch bound correctly (no 'Illegal invocation' when called as a method)", async () => {
    const original = globalThis.fetch;
    // A fetch that throws 'Illegal invocation' if `this` is a non-global object — mimics the browser's WebIDL brand check.
    const guarded = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve({ status: 200, ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer } as unknown as Response);
    };
    globalThis.fetch = guarded as unknown as typeof fetch;
    try {
      const store = new CasBlobStore({ apiBaseUrl: "/gw/tenants/u1" }); // NO fetchImpl → uses the bound default
      await expect(store.get("h")).resolves.not.toBeUndefined(); // must NOT throw Illegal invocation
    } finally {
      globalThis.fetch = original;
    }
  });
});
