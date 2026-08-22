import { describe, it, expect } from "vitest";
import { encode } from "fast-png";
import type { PsdDoc, Layer } from "../src/model/types.js";
import type { PixelRef, BlobStore } from "../src/render/pixel-source.js";
import { PixelCache } from "../src/render/pixel-source.js";
import { render } from "../src/render/index.js";
import { IncrementalCompositor } from "../src/render/incremental.js";

/**
 * Task 1: IncrementalCompositor.reset(newDoc) must swap the resident document
 * WITHOUT discarding the decoded-pixel cache (#ctx: store + PixelCache stay
 * put). This is the crux assertion under test — a layer whose PixelRef hash
 * is unchanged across the reset must NOT be re-fetched from the store.
 */

/** In-memory content-addressed BlobStore that counts `get` calls per hash. */
function countingStore(): BlobStore & { gets: Map<string, number> } {
  const blobs = new Map<string, Uint8Array>();
  const gets = new Map<string, number>();
  let n = 0;
  return {
    gets,
    async put(bytes: Uint8Array) {
      const hash = `blob${n++}`;
      blobs.set(hash, bytes);
      return hash;
    },
    async get(hash: string) {
      gets.set(hash, (gets.get(hash) ?? 0) + 1);
      return blobs.get(hash) ?? null;
    },
  };
}

const canvas = { width: 64, height: 64, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

function fill(w: number, h: number, [r, g, b, a]: [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a;
  }
  return d;
}

/** Puts a solid-color 64x64 PNG blob into the store, returning its PixelRef. */
async function putLayerPixels(store: BlobStore, rgba: [number, number, number, number]): Promise<PixelRef> {
  const data = fill(64, 64, rgba);
  const png = encode({ width: 64, height: 64, data, channels: 4, depth: 8 });
  const hash = await store.put(png);
  return { width: 64, height: 64, hash };
}

function lazyLayer(id: string, ref: PixelRef, over: Partial<Layer> = {}): Layer {
  return {
    id, type: "raster", name: id, bounds: [0, 0, 64, 64], opacity: 1, blendMode: "normal",
    visible: true, locked: false, clipping: false,
    pixels: ref, ...over,
  };
}

describe("IncrementalCompositor.reset(newDoc) keeps the decoded-pixel cache warm", () => {
  it("swaps the doc; unchanged-hash layers are served from cache, only the new-hash layer is fetched", async () => {
    const store = countingStore();

    const bgRef = await putLayerPixels(store, [20, 30, 40, 255]);
    const midRef = await putLayerPixels(store, [255, 0, 0, 200]);
    const topRef = await putLayerPixels(store, [0, 255, 0, 255]);

    const docA: PsdDoc = {
      canvas,
      layers: [
        lazyLayer("bg", bgRef),
        lazyLayer("mid", midRef, { opacity: 0.8 }),
        lazyLayer("top", topRef),
      ],
    };

    const cache = new PixelCache(64 * 1024 * 1024);
    const ctx = { store, cache };
    const comp = new IncrementalCompositor(docA, { tileSize: 64, ctx });

    // 1. composite() on A → every layer's blob fetched at least once.
    await comp.composite();
    expect(store.gets.get(bgRef.hash)).toBeGreaterThanOrEqual(1);
    expect(store.gets.get(midRef.hash)).toBeGreaterThanOrEqual(1);
    expect(store.gets.get(topRef.hash)).toBeGreaterThanOrEqual(1);
    const bgCountAfterA = store.gets.get(bgRef.hash)!;
    const midCountAfterA = store.gets.get(midRef.hash)!;

    // 2. Doc B: shares bg's and mid's hashes (mid's props changed — opacity —
    //    but pixel content, hence hash, is unchanged), DROPS top, and ADDS a
    //    layer with a brand-new hash.
    const newRef = await putLayerPixels(store, [0, 0, 255, 255]);
    expect(store.gets.get(newRef.hash) ?? 0).toBe(0); // put() never calls get()

    const docB: PsdDoc = {
      canvas,
      layers: [
        lazyLayer("bg", bgRef),
        lazyLayer("mid", midRef, { opacity: 0.3 }), // same hash, changed prop
        lazyLayer("new", newRef),
      ],
    };

    // 3. reset(B) then composite().
    comp.reset(docB);
    const pxB = await comp.composite();

    // (b) The warm-cache assertion (the crux): shared-hash layers were NOT
    //     re-fetched from the store — served entirely from the PixelCache
    //     kept alive across reset. Checked BEFORE the oracle render below,
    //     which uses its own fresh cache and would otherwise inflate these
    //     counts with its own (independent) store fetches.
    expect(store.gets.get(bgRef.hash)).toBe(bgCountAfterA);
    expect(store.gets.get(midRef.hash)).toBe(midCountAfterA);

    // (c) Only the genuinely-new hash was fetched (0 → 1).
    expect(store.gets.get(newRef.hash)).toBe(1);

    // (a) Byte-identical to an independent render of B (fresh cache, same
    //     store) — proves reset produces a correct composite of the NEW doc,
    //     not a stale mix of A and B.
    const oraclePx = await render(docB, { store, cache: new PixelCache(64 * 1024 * 1024) });
    expect([...pxB.data]).toEqual([...oraclePx.data]);

    // top's hash is no longer referenced by B; reset must not carry its
    // influence into the new composite (already covered by the byte-parity
    // assertion above, since docB has no "top" layer at all).
  });
});
