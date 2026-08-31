import { describe, it, expect } from "vitest";
import { encode } from "fast-png";
import type { BlobStore, Layer, PsdDoc } from "@unidocs/doctype-psd/engine";
import { RenderCore } from "../src/render-core.js";

const canvas = { width: 64, height: 64, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

function pngBytes(w: number, h: number, alpha: number): Uint8Array {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 200; data[i * 4 + 3] = alpha; }
  return encode({ width: w, height: h, data, channels: 4, depth: 8 });
}

function store(blobs: Record<string, Uint8Array>): BlobStore {
  return {
    async put(): Promise<string> { throw new Error("not implemented"); },
    async get(hash: string): Promise<Uint8Array | null> { return blobs[hash] ?? null; },
  };
}

/** A `store` that also counts `get` calls per hash, so a test can assert a
 *  given layer's blob was never faulted in. */
function countingStore(blobs: Record<string, Uint8Array>): { store: BlobStore; calls: (hash: string) => number } {
  const counts: Record<string, number> = {};
  return {
    store: {
      async put(): Promise<string> { throw new Error("not implemented"); },
      async get(hash: string): Promise<Uint8Array | null> {
        counts[hash] = (counts[hash] ?? 0) + 1;
        return blobs[hash] ?? null;
      },
    },
    calls: (hash: string) => counts[hash] ?? 0,
  };
}

const base = { type: "raster" as const, opacity: 1, blendMode: "normal" as const, visible: true, locked: false, clipping: false };

/** Two lazy layers: a full-canvas backdrop and a small opaque square on top. */
function lazyDoc(): PsdDoc {
  const layers: Layer[] = [
    { ...base, id: "bg", name: "bg", bounds: [0, 0, 64, 64], pixels: { width: 64, height: 64, hash: "h-bg" } },
    { ...base, id: "sq", name: "sq", bounds: [10, 10, 30, 30], pixels: { width: 20, height: 20, hash: "h-sq" } },
  ];
  return { canvas, layers };
}

const blobs = { "h-bg": pngBytes(64, 64, 255), "h-sq": pngBytes(20, 20, 255) };

/** Same backdrop and square, plus a third layer far from both, so a test can
 *  assert it is never faulted in when the sample/target never reaches it. */
function lazyDocWithFar(): PsdDoc {
  const doc = lazyDoc();
  doc.layers.splice(1, 0, {
    ...base, id: "far", name: "far", bounds: [40, 40, 60, 60], pixels: { width: 20, height: 20, hash: "h-far" },
  });
  return doc;
}

const blobsWithFar = { ...blobs, "h-far": pngBytes(20, 20, 255) };

describe("RenderCore.hitTest", () => {
  it("faults lazy pixels in and reports the top layer first", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect((await core.hitTest(15, 15)).map((h) => h.layerId)).toEqual(["sq", "bg"]);
  });

  it("reports only what is actually under the point", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect((await core.hitTest(50, 50)).map((h) => h.layerId)).toEqual(["bg"]);
  });

  // 3 CSS px is 60 document px at the 5% zoom floor, so the radius has to come
  // in per call rather than being a constant in document space.
  it("widens the sample by `radius`, in document pixels", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect((await core.hitTest(33, 20)).map((h) => h.layerId)).toEqual(["bg"]);
    expect((await core.hitTest(33, 20, { radius: 4 })).map((h) => h.layerId)).toEqual(["sq", "bg"]);
  });

  it("re-faults after the document is replaced, rather than serving the old pixel table", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect((await core.hitTest(15, 15)).map((h) => h.layerId)).toEqual(["sq", "bg"]);
    const next = lazyDoc();
    next.layers = [next.layers[0]];
    core.reset(next);
    expect((await core.hitTest(15, 15)).map((h) => h.layerId)).toEqual(["bg"]);
  });

  // A whole-document resident map would pin every decoded layer's Pixels for
  // as long as the doc keeps its identity, defeating the engine's PixelCache
  // eviction under memory pressure on large PSDs. The fault-in must be scoped
  // to what the sample points can actually land on.
  it("never resolves a layer whose bounds miss every sample point", async () => {
    const { store: s, calls } = countingStore(blobsWithFar);
    const core = new RenderCore(lazyDocWithFar(), s);
    await core.hitTest(15, 15);
    expect(calls("h-sq")).toBeGreaterThan(0);
    expect(calls("h-far")).toBe(0);
  });
});

describe("RenderCore.layerAlphaRegion", () => {
  it("returns coverage sized to the layer's box", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    const region = await core.layerAlphaRegion("sq");
    expect(region?.bounds).toEqual([10, 10, 30, 30]);
    expect(region?.data).toHaveLength(20 * 20);
    expect(region?.data[0]).toBe(255);
  });

  it("scales the coverage by the layer's opacity", async () => {
    const doc = lazyDoc();
    doc.layers[1].opacity = 0.5;
    const core = new RenderCore(doc, store(blobs));
    const region = await core.layerAlphaRegion("sq");
    expect(region?.data[0]).toBe(128);
  });

  it("returns null for a layer that is not in the document", async () => {
    const core = new RenderCore(lazyDoc(), store(blobs));
    expect(await core.layerAlphaRegion("ghost")).toBeNull();
  });

  it("does not fault layers outside the target layer's own box", async () => {
    const { store: s, calls } = countingStore(blobsWithFar);
    const core = new RenderCore(lazyDocWithFar(), s);
    await core.layerAlphaRegion("sq");
    expect(calls("h-sq")).toBeGreaterThan(0);
    expect(calls("h-bg")).toBe(0);
    expect(calls("h-far")).toBe(0);
  });
});
