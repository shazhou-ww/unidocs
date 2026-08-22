import { describe, it, expect } from "vitest";
import { encode } from "fast-png";
import type { PsdDoc, Layer, Pixels, BlobStore } from "@unidocs/doctype-psd/engine";
import { render } from "@unidocs/doctype-psd/engine";
import { RenderCore } from "../src/render-core.js";

function fill(w: number, h: number, rgba: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = rgba[0];
    d[i * 4 + 1] = rgba[1];
    d[i * 4 + 2] = rgba[2];
    d[i * 4 + 3] = rgba[3];
  }
  return d;
}

const canvas = { width: 64, height: 64, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };
const bgRgba = [20, 30, 40, 255];
const redRgba = [200, 0, 0, 180];

function pngBytes(w: number, h: number, rgba: number[]): Uint8Array {
  return encode({ width: w, height: h, data: fill(w, h, rgba), channels: 4, depth: 8 });
}

/** Mock BlobStore backed by fast-png-encoded blobs, counting get() calls per hash —
 *  the harness for the "fetch once, not per-edit" invariant. */
function mockStore(blobs: Record<string, Uint8Array>): BlobStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async put(): Promise<string> {
      throw new Error("mockStore.put: not implemented");
    },
    async get(hash: string): Promise<Uint8Array | null> {
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
      return blobs[hash] ?? null;
    },
  };
}

// Two raster layers whose pixels are lazy PixelRefs — the store must be
// faulted in to decode them.
function lazyDoc(): PsdDoc {
  const layers: Layer[] = [
    {
      id: "bg", type: "raster", name: "bg", bounds: [0, 0, 64, 64], opacity: 1, blendMode: "normal",
      visible: true, locked: false, clipping: false,
      pixels: { width: 64, height: 64, hash: "h-bg" },
    },
    {
      id: "red", type: "raster", name: "red", bounds: [8, 8, 40, 40], opacity: 1, blendMode: "multiply",
      visible: true, locked: false, clipping: false,
      pixels: { width: 32, height: 32, hash: "h-red" },
    },
  ];
  return { canvas, layers };
}

// The same document with pixels resident (decoded) — used to verify
// pixel-parity against the engine's plain render(doc).
function residentDoc(): PsdDoc {
  const layers: Layer[] = [
    {
      id: "bg", type: "raster", name: "bg", bounds: [0, 0, 64, 64], opacity: 1, blendMode: "normal",
      visible: true, locked: false, clipping: false,
      pixels: { width: 64, height: 64, data: fill(64, 64, bgRgba) },
    },
    {
      id: "red", type: "raster", name: "red", bounds: [8, 8, 40, 40], opacity: 1, blendMode: "multiply",
      visible: true, locked: false, clipping: false,
      pixels: { width: 32, height: 32, data: fill(32, 32, redRgba) },
    },
  ];
  return { canvas, layers };
}

const bytes = (p: Pixels) => [...p.data];

describe("RenderCore", () => {
  it("exposes doc and tileSize accessors", () => {
    const store = mockStore({});
    const core = new RenderCore(lazyDoc(), store, { tileSize: 32 });
    expect(core.tileSize).toBe(32);
    expect(core.doc.layers.map((l) => l.id)).toEqual(["bg", "red"]);
  });

  it("faults in each lazy layer once on first composite, matching render(residentDoc)", async () => {
    const store = mockStore({ "h-bg": pngBytes(64, 64, bgRgba), "h-red": pngBytes(32, 32, redRgba) });
    const core = new RenderCore(lazyDoc(), store, { tileSize: 32 });

    const first = await core.composite();
    expect(store.counts.get("h-bg")).toBe(1);
    expect(store.counts.get("h-red")).toBe(1);
    expect(bytes(first)).toEqual(bytes(await render(residentDoc())));
  });

  it("reuses the persistent cache across edits — no re-fetch after set_props (the fetch-once invariant)", async () => {
    const store = mockStore({ "h-bg": pngBytes(64, 64, bgRgba), "h-red": pngBytes(32, 32, redRgba) });
    const core = new RenderCore(lazyDoc(), store, { tileSize: 32 });

    await core.composite(); // first frame: faults in both layers
    expect(store.counts.get("h-bg")).toBe(1);
    expect(store.counts.get("h-red")).toBe(1);

    await core.applyOp({ kind: "set_props", payload: { layerId: "red", props: { opacity: 0.5 } } });
    const second = await core.composite();

    // Crux: already-decoded layers are served from the persistent PixelCache —
    // the blob store is NOT hit again for either layer.
    expect(store.counts.get("h-bg")).toBe(1);
    expect(store.counts.get("h-red")).toBe(1);

    const expectedDoc = residentDoc();
    expectedDoc.layers[1]!.opacity = 0.5;
    expect(bytes(second)).toEqual(bytes(await render(expectedDoc)));

    // A second edit to the SAME layer must also avoid re-fetching.
    await core.applyOp({ kind: "set_props", payload: { layerId: "red", props: { opacity: 0.3 } } });
    const third = await core.tile(0, 0);
    void third;
    await core.composite();
    expect(store.counts.get("h-bg")).toBe(1);
    expect(store.counts.get("h-red")).toBe(1);

    const expectedDoc2 = residentDoc();
    expectedDoc2.layers[1]!.opacity = 0.3;
    expect(bytes(await core.composite())).toEqual(bytes(await render(expectedDoc2)));
  });
});
