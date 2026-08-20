import { describe, it, expect } from "vitest";
import { encode } from "fast-png";
import type { PsdDoc, Layer } from "../src/model/types.js";
import type { PixelRef, BlobStore } from "../src/render/pixel-source.js";
import { PixelCache } from "../src/render/pixel-source.js";
import { render, renderCached } from "../src/render/index.js";

/** In-memory content-addressed store that counts gets and tracks the peak
 *  number of concurrently in-flight `get` calls (to prove sequential fault-in).
 *  `get` yields to the event loop so any parallelism would overlap. */
function countingStore(): BlobStore & {
  gets: Map<string, number>;
  peakInFlight: number;
  put(bytes: Uint8Array): Promise<string>;
} {
  const blobs = new Map<string, Uint8Array>();
  const gets = new Map<string, number>();
  let inFlight = 0;
  let peakInFlight = 0;
  let n = 0;
  return {
    gets,
    get peakInFlight() {
      return peakInFlight;
    },
    async put(bytes: Uint8Array) {
      const hash = `blob${n++}`;
      blobs.set(hash, bytes);
      return hash;
    },
    async get(hash: string) {
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      gets.set(hash, (gets.get(hash) ?? 0) + 1);
      // Yield across two macrotasks so overlapping gets would be observed.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      return blobs.get(hash) ?? null;
    },
  };
}

async function put1x1(store: BlobStore, rgba: [number, number, number, number]): Promise<PixelRef> {
  const png = encode({ width: 1, height: 1, data: new Uint8ClampedArray(rgba), channels: 4, depth: 8 });
  const hash = await store.put(png);
  return { width: 1, height: 1, hash };
}

function refLayer(id: string, ref: PixelRef, visible = true): Layer {
  return {
    id,
    type: "raster",
    name: id,
    bounds: [0, 0, 1, 1],
    opacity: 1,
    blendMode: "normal",
    visible,
    locked: false,
    clipping: false,
    pixels: ref,
  };
}

const canvas = { width: 1, height: 1, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

describe("streaming compositor (async fault-in)", () => {
  it("composites two stacked PixelRef layers → top color wins", async () => {
    const store = countingStore();
    const bottom = await put1x1(store, [255, 0, 0, 255]); // red
    const top = await put1x1(store, [0, 0, 255, 255]); // blue
    const doc: PsdDoc = { canvas, layers: [refLayer("bottom", bottom), refLayer("top", top)] };

    const out = await render(doc, { store, cache: new PixelCache(64) });
    expect([...out.data]).toEqual([0, 0, 255, 255]); // opaque blue over red → blue
  });

  it("faults layers in one at a time (peak concurrent get === 1)", async () => {
    const store = countingStore();
    const bottom = await put1x1(store, [255, 0, 0, 255]);
    const top = await put1x1(store, [0, 0, 255, 255]);
    const doc: PsdDoc = { canvas, layers: [refLayer("bottom", bottom), refLayer("top", top)] };

    await render(doc, { store, cache: new PixelCache(64) });
    expect(store.peakInFlight).toBe(1);
  });

  it("never fetches a hidden layer's pixels", async () => {
    const store = countingStore();
    const visRef = await put1x1(store, [0, 255, 0, 255]);
    const hiddenRef = await put1x1(store, [255, 0, 255, 255]);
    const doc: PsdDoc = {
      canvas,
      layers: [refLayer("vis", visRef), refLayer("hidden", hiddenRef, false)],
    };

    await render(doc, { store, cache: new PixelCache(64) });
    expect(store.gets.get(visRef.hash) ?? 0).toBe(1);
    expect(store.gets.get(hiddenRef.hash) ?? 0).toBe(0); // hidden → never faulted in
  });

  it("a transient render failure does not permanently brick a doc (renderCached retries)", async () => {
    // Store whose get() throws on the FIRST call then succeeds afterwards.
    const blobs = new Map<string, Uint8Array>();
    let calls = 0;
    let n = 0;
    const store: BlobStore = {
      async put(bytes: Uint8Array) {
        const hash = `blob${n++}`;
        blobs.set(hash, bytes);
        return hash;
      },
      async get(hash: string) {
        calls++;
        if (calls === 1) throw new Error("transient blob store failure");
        return blobs.get(hash) ?? null;
      },
    };
    const ref = await put1x1(store, [0, 200, 0, 255]);
    const doc: PsdDoc = { canvas, layers: [refLayer("only", ref)] };

    // Same doc object both times → doc identity is the framebuffer cache key.
    // 1st render rejects (transient failure) and must NOT be cached.
    await expect(renderCached(doc, { store, cache: new PixelCache(64) })).rejects.toThrow(/transient blob store failure/);
    // 2nd render on the SAME doc retries (slot was dropped) and resolves.
    const px = await renderCached(doc, { store, cache: new PixelCache(64) });
    expect([...px.data]).toEqual([0, 200, 0, 255]);
  });
});
