import { describe, it, expect } from "vitest";
import { encode } from "fast-png";
import { resolvePixels, type PixelSource, type BlobStore } from "../src/render/pixel-source.js";
import { PixelCache } from "../src/render/pixel-source.js";

function memStore(): BlobStore & { gets: number; blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>(); let gets = 0;
  return { blobs, get gets() { return gets; },
    async put(b) { const h = `h${blobs.size}`; blobs.set(h, b); return h; },
    async get(h) { gets++; return blobs.get(h) ?? null; } } as any;
}

describe("pixel-source", () => {
  it("resident passes through; ref decodes from store then caches", async () => {
    const store = memStore();
    const data = new Uint8ClampedArray([1, 2, 3, 255]);
    const png = encode({ width: 1, height: 1, data, channels: 4, depth: 8 });
    const hash = await store.put(png);
    const cache = new PixelCache(4);
    const ref: PixelSource = { width: 1, height: 1, hash };
    const a = await resolvePixels(ref, store, cache);
    expect([...a.data]).toEqual([1, 2, 3, 255]);
    await resolvePixels(ref, store, cache);
    expect(store.gets).toBe(1); // second call served from cache
  });

  it("resident Pixels pass through untouched, never touching the store", async () => {
    const store = memStore();
    const cache = new PixelCache(4);
    const resident: PixelSource = { width: 2, height: 1, data: new Uint8ClampedArray([9, 8, 7, 255, 6, 5, 4, 255]) };
    const out = await resolvePixels(resident, store, cache);
    expect(out).toBe(resident); // same object, not a copy
    expect(store.gets).toBe(0); // resident never hits the store
  });

  it("PixelCache evicts the least-recently-used beyond capacity", async () => {
    const store = memStore();
    const cache = new PixelCache(2); // capacity 2
    const mk = async (rgba: number[]): Promise<PixelSource> => {
      const png = encode({ width: 1, height: 1, data: new Uint8ClampedArray(rgba), channels: 4, depth: 8 });
      const hash = await store.put(png);
      return { width: 1, height: 1, hash };
    };
    const a = await mk([1, 0, 0, 255]);
    const b = await mk([2, 0, 0, 255]);
    const c = await mk([3, 0, 0, 255]);

    await resolvePixels(a, store, cache); // cache: [a]
    await resolvePixels(b, store, cache); // cache: [a, b]
    expect(store.gets).toBe(2);
    await resolvePixels(a, store, cache); // hit; a now most-recent → cache: [b, a]
    expect(store.gets).toBe(2);
    await resolvePixels(c, store, cache); // adds c, evicts LRU (b) → cache: [a, c]
    expect(store.gets).toBe(3);
    await resolvePixels(a, store, cache); // still cached
    expect(store.gets).toBe(3);
    await resolvePixels(b, store, cache); // b was evicted → must refetch
    expect(store.gets).toBe(4);
  });

  it("throws a clear error when the store has no blob for a ref", async () => {
    const store = memStore();
    const cache = new PixelCache(4);
    const missing: PixelSource = { width: 1, height: 1, hash: "does-not-exist" };
    await expect(resolvePixels(missing, store, cache)).rejects.toThrow(/no blob found in store/);
  });
});
