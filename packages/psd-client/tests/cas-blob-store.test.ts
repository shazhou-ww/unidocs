import { describe, it, expect } from "vitest";
import {
  CanonicalNodeContentType,
  hashToHex,
  parseNodeBytes,
  sha256,
} from "@unicas/codec";
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

describe("CasBlobStore.put", () => {
  it("leases a canonical image node and returns its canonical hash", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), init };
      return { status: 200, ok: true } as Response;
    }) as typeof fetch;
    const png = new Uint8Array([137, 80, 78, 71]);
    const store = new CasBlobStore({ apiBaseUrl: "/gw/tenants/u1", fetchImpl });

    const hash = await store.put(png);

    expect(request?.url).toBe(`/gw/tenants/u1/cas/nodes/${hash}/lease`);
    expect(request?.init?.method).toBe("POST");
    expect(new Headers(request?.init?.headers).get("Content-Type")).toBe(CanonicalNodeContentType);
    const canonicalBytes = request?.init?.body as Uint8Array;
    expect(hash).toBe(hashToHex(await sha256(canonicalBytes)));
    const parsed = parseNodeBytes(canonicalBytes);
    expect(parsed.contentType).toBe("image/png");
    expect(parsed.childHashes).toEqual([]);
    expect(parsed.content).toEqual(png);
  });

  it("reports a failed lease", async () => {
    const fetchImpl = (async () => ({ status: 403, ok: false }) as Response) as typeof fetch;
    const store = new CasBlobStore({ apiBaseUrl: "/gw/tenants/u1", fetchImpl });
    await expect(store.put(new Uint8Array([1]))).rejects.toThrow(
      /CasBlobStore\.put: unexpected status 403/,
    );
  });
});
