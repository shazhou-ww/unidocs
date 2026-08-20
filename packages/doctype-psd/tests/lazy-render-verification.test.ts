import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import type { PsdDoc, Layer, Pixels } from "../src/model/types.js";
import type { PixelRef, BlobStore } from "../src/render/pixel-source.js";
import { isRef, PixelCache } from "../src/render/pixel-source.js";
import { serialize, deserialize } from "../src/psd/ir.js";
import { render } from "../src/render/index.js";
import { load } from "../src/psd/load.js";

/**
 * Payoff verification for the lazy-pixel path: serialize → deserialize
 * yields a doc whose layers are lazy `PixelRef`s; streaming them back through
 * the compositor from a BlobStore must (a) produce a byte-identical render to
 * the fully-resident path, (b) never hold more decoded pixel bytes than the
 * cache's byte budget at any point during the render, and (c) never fault in
 * a hidden layer's pixels at all.
 *
 * Deliberately deterministic — no RSS/process-memory sampling (flaky under
 * GC timing); memory is bounded by instrumenting `PixelCache` itself.
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

/** A PixelCache that records the peak total decoded bytes it ever held,
 *  sampled right after each `set` (i.e. post-eviction) — the only moment
 *  the cache's resident size actually changes. */
class TrackingCache extends PixelCache {
  peak = 0;
  override set(hash: string, pixels: Pixels): void {
    super.set(hash, pixels);
    this.peak = Math.max(this.peak, this.sizeBytes);
  }
}

function fill(w: number, h: number, [r, g, b, a]: [number, number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = r;
    d[i * 4 + 1] = g;
    d[i * 4 + 2] = b;
    d[i * 4 + 3] = a;
  }
  return d;
}

const TILE = 64;
const LAYER_BYTES = TILE * TILE * 4; // 16384 decoded bytes per layer

// 6 distinct-colored 64x64 tiles exactly covering a 192x128 canvas (3x2 grid).
const COLORS: [number, number, number, number][] = [
  [255, 0, 0, 255], // red
  [0, 255, 0, 255], // green
  [0, 0, 255, 255], // blue
  [255, 255, 0, 255], // yellow
  [0, 255, 255, 255], // cyan
  [255, 0, 255, 255], // magenta
];
const BOUNDS: [number, number, number, number][] = [
  [0, 0, 64, 64],
  [0, 64, 64, 128],
  [0, 128, 64, 192],
  [64, 0, 128, 64],
  [64, 64, 128, 128],
  [64, 128, 128, 192],
];

const canvas = { width: 192, height: 128, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

function makeLayer(id: string, bounds: [number, number, number, number], color: [number, number, number, number], visible = true): Layer {
  return {
    id,
    type: "raster",
    name: id,
    bounds,
    opacity: 1,
    blendMode: "normal",
    visible,
    locked: false,
    clipping: false,
    pixels: { width: TILE, height: TILE, data: fill(TILE, TILE, color) },
  };
}

/** 6 visible, distinctly-colored, non-overlapping raster layers (16384 bytes
 *  decoded each — 98304 bytes total) plus one full-canvas HIDDEN layer with
 *  its own distinct color (another 16384 bytes, never rendered). Total
 *  decoded doc pixel bytes: 114688 — comfortably above the cache budget
 *  the parity/bounded-memory test below uses. */
function buildResidentDoc(): PsdDoc {
  const visibleLayers = BOUNDS.map((b, i) => makeLayer(`vis-${i}`, b, COLORS[i]));
  const hidden = makeLayer("hidden-0", [0, 0, 128, 192], [128, 128, 128, 255], false);
  return { canvas, layers: [...visibleLayers, hidden] };
}

function compareBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  return Buffer.compare(
    Buffer.from(a.buffer, a.byteOffset, a.length),
    Buffer.from(b.buffer, b.byteOffset, b.length),
  );
}

describe("lazy-pixel render: parity + bounded memory + hidden-skip", () => {
  it("renders byte-identically to the resident path, bounds cache memory to the budget, and never fetches the hidden layer", async () => {
    const residentDoc = buildResidentDoc();

    // 1. Resident render is the parity oracle.
    const residentPx = await render(residentDoc);
    expect(residentPx.width).toBe(192);
    expect(residentPx.height).toBe(128);

    // 2. Serialize (resident → byte-free IR + per-layer blobs) then
    //    deserialize (IR → lazy doc). A DIFFERENT doc object than
    //    residentDoc, so no shared identity/state with the resident render.
    const store = countingStore();
    const bytes = await serialize(residentDoc, store);
    const lazyDoc = await deserialize(bytes, store);

    // All raster layers — visible and hidden alike — come back as lazy
    // PixelRefs; deserialize never eagerly fetches/decodes layer pixels.
    for (const l of lazyDoc.layers) {
      expect(isRef(l.pixels!)).toBe(true);
    }

    // 3. Parity: render the lazy doc through a byte-budget cache SMALLER
    //    than the doc's total decoded pixel bytes (114688) — in fact
    //    smaller than even the visible-only total (98304): only 2 layers'
    //    worth (32768 bytes).
    const BUDGET = LAYER_BYTES * 2;
    const cache = new TrackingCache(BUDGET);
    const lazyPx = await render(lazyDoc, { store, cache });

    expect(lazyPx.width).toBe(residentPx.width);
    expect(lazyPx.height).toBe(residentPx.height);
    expect(compareBytes(lazyPx.data, residentPx.data)).toBe(0);

    // 4. Bounded memory: the cache's peak resident size, sampled after every
    //    insertion during the render, never exceeded the budget — proving
    //    resident decoded pixels are capped by the cache budget, not by the
    //    document's layer count (6 visible layers were streamed through a
    //    cache that never held more than 2 layers' worth at once).
    const totalDocBytes = LAYER_BYTES * (BOUNDS.length + 1); // 6 visible + 1 hidden
    expect(cache.peak).toBeGreaterThan(0);
    expect(cache.peak).toBeLessThanOrEqual(BUDGET);
    expect(cache.peak).toBeLessThan(totalDocBytes);

    // eslint-disable-next-line no-console
    console.log(`[lazy-render] peak cache bytes=${cache.peak} budget=${BUDGET} totalDocPixelBytes=${totalDocBytes}`);

    // 5. Hidden layer is never faulted in: renderList skips invisible layers
    //    BEFORE resolvePixels runs, so its blob (present in the store — it
    //    was serialized like everything else) is never `get`.
    const hiddenLazy = lazyDoc.layers.find((l) => l.id === "hidden-0")!;
    const hiddenHash = (hiddenLazy.pixels as PixelRef).hash;
    expect(store.gets.get(hiddenHash) ?? 0).toBe(0);

    // All 6 visible layers' blobs were fetched at least once.
    for (let i = 0; i < BOUNDS.length; i++) {
      const visLayer = lazyDoc.layers.find((l) => l.id === `vis-${i}`)!;
      const hash = (visLayer.pixels as PixelRef).hash;
      expect(store.gets.get(hash) ?? 0).toBeGreaterThanOrEqual(1);
    }
  });
});

// Optional, env-gated: same parity check against a real multi-layer PSD, if
// present on this machine. Skips cleanly (does not fail CI) when absent.
describe("lazy render on a real PSD (env-gated)", () => {
  const psdPath = "/Users/yanjiayi/Downloads/landing-page-capture-yourself-theme/4414025.psd";
  const present = existsSync(psdPath);
  const run = present ? it : it.skip;

  run(
    "byte-identical lazy vs resident render on a real multi-layer PSD",
    async () => {
      const raw = new Uint8Array(readFileSync(psdPath));
      const residentDoc = await load(raw);
      const residentPx = await render(residentDoc);

      const store = countingStore();
      const irBytes = await serialize(residentDoc, store);
      const lazyDoc = await deserialize(irBytes, store);

      const cache = new PixelCache(64 * 1024 * 1024);
      const lazyPx = await render(lazyDoc, { store, cache });

      expect(lazyPx.width).toBe(residentPx.width);
      expect(lazyPx.height).toBe(residentPx.height);
      expect(compareBytes(lazyPx.data, residentPx.data)).toBe(0);
    },
    180000,
  );

  if (!present) {
    // eslint-disable-next-line no-console
    console.log(`[lazy-render] real-PSD case SKIPPED (not found at ${psdPath})`);
  }
});
