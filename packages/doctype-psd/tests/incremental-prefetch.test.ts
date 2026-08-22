import { describe, it, expect } from "vitest";
import { encode } from "fast-png";
import type { PsdDoc, Layer } from "../src/model/types.js";
import type { BlobStore } from "../src/render/pixel-source.js";
import { PixelCache } from "../src/render/pixel-source.js";
import { render } from "../src/render/index.js";
import { IncrementalCompositor } from "../src/render/incremental.js";

/** A BlobStore that PNG-encodes a fixed RGBA fill per hash and counts `get`
 *  calls per hash, so a test can assert each blob is fetched at most once. */
function countingStore(): BlobStore & { getsFor(hash: string): number } {
  const blobs = new Map<string, Uint8Array>();
  const counts = new Map<string, number>();
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const hash = `h${blobs.size}`;
      blobs.set(hash, bytes);
      return hash;
    },
    async get(hash: string): Promise<Uint8Array | null> {
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
      return blobs.get(hash) ?? null;
    },
    getsFor(hash: string): number {
      return counts.get(hash) ?? 0;
    },
  };
}

function fill(w: number, h: number, rgba: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = rgba[0]; d[i * 4 + 1] = rgba[1]; d[i * 4 + 2] = rgba[2]; d[i * 4 + 3] = rgba[3];
  }
  return d;
}

const canvas = { width: 64, height: 64, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

/** Builds a lazy doc (every raster layer's `pixels` is a PixelRef into
 *  `store`) plus the resident-equivalent doc for byte comparison, and a group
 *  with a nested child so `prefetch`'s recursive walk is exercised. */
async function lazyDocAndResident(store: BlobStore): Promise<{ lazy: PsdDoc; resident: PsdDoc; hashes: string[] }> {
  const mkResident = (id: string, b: [number, number, number, number], rgba: number[]): Layer => ({
    id, type: "raster", name: id, bounds: b, opacity: 1, blendMode: "normal",
    visible: true, locked: false, clipping: false,
    pixels: { width: b[3] - b[1], height: b[2] - b[0], data: fill(b[3] - b[1], b[2] - b[0], rgba) },
  });
  const bg = mkResident("bg", [0, 0, 64, 64], [10, 20, 30, 255]);
  const child = mkResident("child", [4, 4, 20, 20], [200, 0, 0, 255]);
  const group: Layer = {
    id: "grp", type: "group", name: "grp", bounds: [4, 4, 20, 20], opacity: 1, blendMode: "normal",
    visible: true, locked: false, clipping: false, children: [child],
  };
  const top = mkResident("top", [30, 30, 50, 50], [0, 0, 200, 255]);
  const resident: PsdDoc = { canvas, layers: [bg, group, top] };

  // Build the lazy equivalent by hand: put each raster layer's PNG into the
  // store and replace `pixels` with a PixelRef.
  const toRef = async (layer: Layer): Promise<Layer> => {
    if (layer.pixels && "data" in layer.pixels) {
      const px = layer.pixels;
      const png = encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });
      const hash = await store.put(png);
      return { ...layer, pixels: { width: px.width, height: px.height, hash } };
    }
    if (layer.children) {
      return { ...layer, children: await Promise.all(layer.children.map(toRef)) };
    }
    return layer;
  };
  const lazyLayers = await Promise.all(resident.layers.map(toRef));
  const lazy: PsdDoc = { canvas, layers: lazyLayers };
  const hashes = [
    (lazyLayers[0].pixels as any).hash,
    (((lazyLayers[1].children as Layer[])[0]).pixels as any).hash,
    (lazyLayers[2].pixels as any).hash,
  ];
  return { lazy, resident, hashes };
}

describe("IncrementalCompositor.prefetch", () => {
  it("fetches every layer/mask blob exactly once, in parallel, then composite() does zero further fetches", async () => {
    const store = countingStore();
    const { lazy, resident, hashes } = await lazyDocAndResident(store);
    const cache = new PixelCache(1 << 24);
    const comp = new IncrementalCompositor(lazy, { tileSize: 32, ctx: { store, cache } });

    // Nothing fetched yet — prefetch hasn't run.
    for (const h of hashes) expect(store.getsFor(h)).toBe(0);

    await comp.prefetch();

    // Every distinct blob was fetched exactly once (dedup + warm).
    for (const h of hashes) expect(store.getsFor(h)).toBe(1);

    // composite() must be served entirely from the warmed PixelCache: no
    // counter increases, proving zero network calls after prefetch.
    const composited = await comp.composite();
    for (const h of hashes) expect(store.getsFor(h)).toBe(1);

    // And the output is byte-identical to rendering the resident doc.
    const expected = await render(resident);
    expect([...composited.data]).toEqual([...expected.data]);
  });

  it("dedups repeated hashes: a layer and its duplicate (same content) fetch the blob once", async () => {
    const store = countingStore();
    const px = { width: 4, height: 4, data: fill(4, 4, [1, 2, 3, 255]) };
    const png = encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });
    const hash = await store.put(png);
    const mkLayer = (id: string): Layer => ({
      id, type: "raster", name: id, bounds: [0, 0, 4, 4], opacity: 1, blendMode: "normal",
      visible: true, locked: false, clipping: false,
      pixels: { width: 4, height: 4, hash },
    });
    const doc: PsdDoc = { canvas: { width: 4, height: 4, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [mkLayer("a"), mkLayer("b")] };
    const cache = new PixelCache(1 << 20);
    const comp = new IncrementalCompositor(doc, { ctx: { store, cache } });

    await comp.prefetch();
    expect(store.getsFor(hash)).toBe(1); // shared hash → fetched once, not twice
  });

  it("is a no-op when the doc has no lazy PixelRefs (resident-only)", async () => {
    const store = countingStore();
    const resident: Layer = {
      id: "a", type: "raster", name: "a", bounds: [0, 0, 2, 2], opacity: 1, blendMode: "normal",
      visible: true, locked: false, clipping: false,
      pixels: { width: 2, height: 2, data: fill(2, 2, [1, 1, 1, 255]) },
    };
    const doc: PsdDoc = { canvas: { width: 2, height: 2, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [resident] };
    const comp = new IncrementalCompositor(doc, { ctx: { store, cache: new PixelCache(1 << 20) } });
    await expect(comp.prefetch()).resolves.toBeUndefined();
  });
});
