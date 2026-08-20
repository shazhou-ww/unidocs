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
});
