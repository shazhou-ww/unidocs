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
    const s = new CasBlobStore({ gw: "/gw", user: "u1", fetchImpl: mockFetch({ "/gw/users/u1/cas/nodes/abc/content": { status: 200, body: bytes } }) });
    expect([...(await s.get("abc"))!]).toEqual([1, 2, 3]);
  });
  it("returns null on 404", async () => {
    const s = new CasBlobStore({ gw: "/gw", user: "u1", fetchImpl: mockFetch({}) });
    expect(await s.get("missing")).toBeNull();
  });
});
