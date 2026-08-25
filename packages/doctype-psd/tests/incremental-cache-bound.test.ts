import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer, Pixels } from "../src/model/types.js";
import { IncrementalCompositor } from "../src/render/incremental.js";
import { render } from "../src/render/composite.js";
import { allTiles } from "../src/render/tile-grid.js";

/**
 * The tile-level caches must stay inside their byte budget. They were plain
 * unbounded Maps, which grow with canvas area without limit — fine in a tab,
 * fatal in an Editor DO (a hard 128 MB isolate). Everything they hold is
 * reconstructible, so the bound must cost only speed: parity with `render(doc)`
 * has to survive eviction, including eviction happening mid-composite.
 */

function layer(id: string, w: number, h: number, seed: number): Layer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 5 + seed) % 256;
    data[i * 4 + 1] = (i * 11 + seed) % 256;
    data[i * 4 + 2] = (i * 17 + seed) % 256;
    data[i * 4 + 3] = i % 7 === 0 ? 128 : 255; // some translucency to exercise blending
  }
  const pixels: Pixels = { width: w, height: h, data };
  return { id, name: id, type: "raster", opacity: 0.9, blendMode: "normal", visible: true, bounds: [0, 0, h, w], pixels } as unknown as Layer;
}

const doc = (w: number, h: number, n: number): PsdDoc => ({
  canvas: { width: w, height: h },
  layers: Array.from({ length: n }, (_, i) => layer(`L${i}`, w, h, i * 31)),
} as unknown as PsdDoc);

describe("IncrementalCompositor tile caches are byte-bounded", () => {
  it("stays within a tight budget while remaining byte-identical to render(doc)", async () => {
    const d = doc(320, 320, 3);
    const TILE = 32;
    // 10x10 = 100 tiles of 32x32x4 = 4096 B each -> 409,600 B unbounded.
    // Budget deliberately holds only ~4 tiles, forcing continuous eviction.
    const budget = 4 * TILE * TILE * 4;
    const comp = new IncrementalCompositor(d, { tileSize: TILE, tileCacheBytes: budget, checkpointBytes: budget });

    const total = allTiles(d.canvas, TILE).length;
    expect(total).toBe(100);

    const out = await comp.composite();
    const expected = await render(d);
    expect(out.data).toEqual(expected.data);

    // The bound is the point: an oversized single entry may exceed it, but a
    // 4096-byte tile is far under, so the cache must sit at or below budget.
    expect(comp.cacheBytes.tiles).toBeLessThanOrEqual(budget);
    expect(comp.cacheBytes.checkpoints).toBeLessThanOrEqual(budget);
  });

  it("re-composites evicted tiles correctly instead of returning stale ones", async () => {
    const d = doc(256, 256, 2);
    const TILE = 32;
    const budget = 2 * TILE * TILE * 4; // 64 tiles in the grid, room for 2
    const comp = new IncrementalCompositor(d, { tileSize: TILE, tileCacheBytes: budget, checkpointBytes: budget });

    await comp.composite();
    // Every tile has been evicted many times over by now; reading them again
    // must rebuild each one to the same bytes a fresh full render produces.
    const expected = await render(d);
    for (const t of allTiles(d.canvas, TILE)) {
      const px = await comp.readTile(t.tx, t.ty);
      const [top, left] = t.region;
      for (let y = 0; y < px.height; y++) {
        const got = px.data.subarray(y * px.width * 4, (y + 1) * px.width * 4);
        const want = expected.data.subarray(((top + y) * d.canvas.width + left) * 4, ((top + y) * d.canvas.width + left + px.width) * 4);
        expect(got).toEqual(want);
      }
    }
  });

  it("survives eviction across an applyOp (dirty-rect invalidation still correct)", async () => {
    const d = doc(256, 256, 3);
    const TILE = 32;
    const budget = 3 * TILE * TILE * 4;
    const comp = new IncrementalCompositor(d, { tileSize: TILE, tileCacheBytes: budget, checkpointBytes: budget });

    await comp.composite();
    await comp.applyOp({ kind: "set_props", payload: { layerId: "L1", props: { visible: false } } } as never);
    const got = await comp.composite();
    const expected = await render(comp.doc);
    expect(got.data).toEqual(expected.data);
    expect(comp.cacheBytes.tiles).toBeLessThanOrEqual(budget);
  });

  it("defaults to a bound rather than unbounded growth", async () => {
    const d = doc(128, 128, 1);
    const comp = new IncrementalCompositor(d, { tileSize: 32 });
    await comp.composite();
    // Default budget is generous; the point is that a budget exists and the
    // accounting is live rather than the caches being untracked Maps.
    expect(comp.cacheBytes.tiles).toBeGreaterThan(0);
    expect(comp.cacheBytes.tiles).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
