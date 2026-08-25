import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { PsdDoc, Layer, Pixels } from "../src/model/types.js";
import type { BlobStore } from "../src/render/pixel-source.js";
import { DocRenderState } from "../src/render/doc-render-state.js";
import { render, renderRegion } from "../src/render/composite.js";
import { apply } from "../src/ops/index.js";
import { serialize, deserialize } from "../src/psd/ir.js";

/**
 * `DocRenderState` is the server's persistent render state. It may only change
 * WHEN work happens, never WHAT comes out: every preview it produces has to be
 * byte-identical to the stateless path it replaces (`render` / `renderRegion`),
 * including after edits, after eviction, and after being re-pointed at a
 * document it did not produce (rollback / delta replay).
 */

function countingStore(): BlobStore & { gets: number } {
  const blobs = new Map<string, Uint8Array>();
  const s = {
    gets: 0,
    async put(bytes: Uint8Array) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    },
    async get(hash: string) {
      s.gets++;
      return blobs.get(hash) ?? null;
    },
  };
  return s;
}

function layer(id: string, w: number, h: number, seed: number, extra: Record<string, unknown> = {}): Layer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 5 + seed) % 256;
    data[i * 4 + 1] = (i * 11 + seed) % 256;
    data[i * 4 + 2] = (i * 17 + seed) % 256;
    data[i * 4 + 3] = i % 5 === 0 ? 90 : 255;
  }
  const pixels: Pixels = { width: w, height: h, data };
  return {
    id, name: id, type: "raster", opacity: 0.85, blendMode: "normal", visible: true,
    bounds: [0, 0, h, w], pixels, ...extra,
  } as unknown as Layer;
}

/** A doc with overlapping, offset, translucent layers — not all full-canvas,
 *  so region math has real edges to get wrong. */
function makeDoc(): PsdDoc {
  const l0 = layer("L0", 200, 150, 3);
  const l1 = layer("L1", 90, 70, 41);
  (l1 as unknown as { bounds: number[] }).bounds = [30, 40, 100, 130];
  const l2 = layer("L2", 60, 60, 97);
  (l2 as unknown as { bounds: number[] }).bounds = [80, 120, 140, 180];
  return { canvas: { width: 200, height: 150 }, layers: [l0, l1, l2] } as unknown as PsdDoc;
}

/** Round-trip through the CAS so layers are lazy PixelRefs, as on the server. */
async function lazy(doc: PsdDoc): Promise<{ doc: PsdDoc; store: BlobStore & { gets: number } }> {
  const store = countingStore();
  const bytes = await serialize(doc, store);
  return { doc: await deserialize(bytes, store), store };
}

const TILE = 32; // deliberately not a divisor of 200x150 — exercises partial edge tiles

describe("DocRenderState parity with the stateless render path", () => {
  it("composite() is byte-identical to render(doc)", async () => {
    const { doc, store } = await lazy(makeDoc());
    const state = new DocRenderState(store, { tileSize: TILE });
    const got = await state.composite(doc);
    const want = await render(doc, state.ctx);
    expect(got.width).toBe(want.width);
    expect(got.height).toBe(want.height);
    expect(got.data).toEqual(want.data);
  });

  it("region() is byte-identical to renderRegion() for aligned, unaligned and clipped rects", async () => {
    const { doc, store } = await lazy(makeDoc());
    const state = new DocRenderState(store, { tileSize: TILE });
    const rects: Array<[number, number, number, number]> = [
      [0, 0, 32, 32],       // exactly one tile
      [0, 0, 150, 200],     // whole canvas
      [10, 17, 99, 143],    // unaligned on all four sides
      [140, 190, 150, 200], // bottom-right corner, partial edge tiles
      [-20, -20, 40, 40],   // clipped to canvas
      [64, 64, 65, 65],     // single pixel
    ];
    for (const rect of rects) {
      const got = await state.region(doc, rect);
      const want = await renderRegion(doc, rect, state.ctx);
      expect(got.width, `rect ${rect}`).toBe(want.width);
      expect(got.height, `rect ${rect}`).toBe(want.height);
      expect(got.data, `rect ${rect}`).toEqual(want.data);
    }
  });

  it("applyOps produces the same document as the stateless apply()", async () => {
    const { doc, store } = await lazy(makeDoc());
    const ops = [
      { kind: "set_props", payload: { layerId: "L1", props: { visible: false } } },
      { kind: "set_props", payload: { layerId: "L2", props: { opacity: 0.4 } } },
      { kind: "set_props", payload: { layerId: "L0", props: { blendMode: "multiply" } } },
    ] as never[];

    const state = new DocRenderState(store, { tileSize: TILE });
    const viaState = await state.applyOps(ops, doc);
    const viaFree = await apply(ops, doc);

    expect(JSON.stringify(viaState.canvas)).toBe(JSON.stringify(viaFree.canvas));
    const gotPx = await state.composite(viaState);
    const wantPx = await render(viaFree, state.ctx);
    expect(gotPx.data).toEqual(wantPx.data);
  });

  it("stays byte-identical across a sequence of edits (incremental invalidation is not stale)", async () => {
    const { doc, store } = await lazy(makeDoc());
    const state = new DocRenderState(store, { tileSize: TILE });
    let cur = doc;
    await state.composite(cur); // warm every tile first

    const seq = [
      { kind: "set_props", payload: { layerId: "L1", props: { visible: false } } },
      { kind: "set_props", payload: { layerId: "L1", props: { visible: true } } },
      { kind: "set_props", payload: { layerId: "L0", props: { opacity: 0.3 } } },
      { kind: "set_props", payload: { layerId: "L2", props: { blendMode: "screen" } } },
      { kind: "set_props", payload: { layerId: "L2", props: { visible: false } } },
    ] as never[];

    for (const op of seq) {
      cur = await state.applyOps([op], cur);
      const got = await state.composite(cur);
      const want = await render(cur, state.ctx);
      expect(got.data, `after ${JSON.stringify(op)}`).toEqual(want.data);
      const gotR = await state.region(cur, [12, 20, 91, 137]);
      const wantR = await renderRegion(cur, [12, 20, 91, 137], state.ctx);
      expect(gotR.data, `region after ${JSON.stringify(op)}`).toEqual(wantR.data);
    }
  });

  it("re-points onto a document it did not produce (rollback / delta replay)", async () => {
    const { doc, store } = await lazy(makeDoc());
    const state = new DocRenderState(store, { tileSize: TILE });
    const edited = await state.applyOps(
      [{ kind: "set_props", payload: { layerId: "L1", props: { visible: false } } }] as never[],
      doc,
    );
    await state.composite(edited);
    // Hand back the ORIGINAL doc, as #reconstruct does when replaying from an
    // older base — the tile state belongs to `edited` and must be discarded.
    const got = await state.composite(doc);
    const want = await render(doc, state.ctx);
    expect(got.data).toEqual(want.data);
  });

  it("keeps decoded pixels warm across previews instead of re-fetching per request", async () => {
    const { doc, store } = await lazy(makeDoc());
    const state = new DocRenderState(store, { tileSize: TILE });

    await state.composite(doc);
    const afterFirst = store.gets;
    expect(afterFirst).toBeGreaterThan(0); // cold: layers faulted in

    await state.composite(doc);
    await state.region(doc, [0, 0, 64, 64]);
    const edited = await state.applyOps(
      [{ kind: "set_props", payload: { layerId: "L1", props: { opacity: 0.2 } } }] as never[],
      doc,
    );
    await state.composite(edited);

    // The whole point: nothing was re-fetched. The stateless path built a fresh
    // PixelCache per call and would have re-fetched every layer each time.
    expect(store.gets).toBe(afterFirst);
  });

  it("recomposites only the tiles an edit dirties", async () => {
    const { doc, store } = await lazy(makeDoc());
    const state = new DocRenderState(store, { tileSize: TILE });
    await state.composite(doc);

    // L2 occupies [80,120,140,180] — well away from the top-left corner.
    const edited = await state.applyOps(
      [{ kind: "set_props", payload: { layerId: "L2", props: { visible: false } } }] as never[],
      doc,
    );
    const cornerBefore = await state.region(doc, [0, 0, 32, 32]);
    const cornerAfter = await state.region(edited, [0, 0, 32, 32]);
    // Untouched region is unchanged...
    expect(cornerAfter.data).toEqual(cornerBefore.data);
    // ...and the edited region really did change.
    const hit = await state.region(edited, [80, 120, 140, 180]);
    const hitWant = await renderRegion(edited, [80, 120, 140, 180], state.ctx);
    expect(hit.data).toEqual(hitWant.data);
  });

  // A document whose decoded layers exceed the pixel-cache budget must NOT be
  // tiled: every tile would walk the whole stack and evict what the next tile
  // needs, re-fetching and re-decoding the document once per tile (measured:
  // 1.4s stateless vs 56s tiled on a real 125 MB file). It falls back to the
  // stateless entrypoints — which still has to produce the same bytes.
  describe("document too large to tile falls back without changing output", () => {
    // makeDoc's layers decode to ~168 KB; a 32 KB budget forces the fallback.
    const TINY = 32 * 1024;

    it("composite() matches render(doc)", async () => {
      const { doc, store } = await lazy(makeDoc());
      const state = new DocRenderState(store, { tileSize: TILE, pixelCacheBytes: TINY });
      const got = await state.composite(doc);
      const want = await render(doc, state.ctx);
      expect(got.data).toEqual(want.data);
      // Nothing was tiled.
      expect(state.cacheBytes.tiles).toBe(0);
    });

    it("region() matches renderRegion() on aligned and unaligned rects", async () => {
      const { doc, store } = await lazy(makeDoc());
      const state = new DocRenderState(store, { tileSize: TILE, pixelCacheBytes: TINY });
      for (const rect of [[0, 0, 32, 32], [10, 17, 99, 143], [140, 190, 150, 200]] as Array<[number, number, number, number]>) {
        const got = await state.region(doc, rect);
        const want = await renderRegion(doc, rect, state.ctx);
        expect(got.width, `rect ${rect}`).toBe(want.width);
        expect(got.height, `rect ${rect}`).toBe(want.height);
        expect(got.data, `rect ${rect}`).toEqual(want.data);
      }
    });

    it("region() cropped from an already-built frame matches renderRegion()", async () => {
      const { doc, store } = await lazy(makeDoc());
      const state = new DocRenderState(store, { tileSize: TILE, pixelCacheBytes: TINY });
      await state.composite(doc); // now a full frame for this exact doc is in hand
      for (const rect of [[0, 0, 32, 32], [10, 17, 99, 143], [-5, -5, 40, 40], [64, 64, 65, 65]] as Array<[number, number, number, number]>) {
        const got = await state.region(doc, rect);
        const want = await renderRegion(doc, rect, state.ctx);
        expect(got.width, `rect ${rect}`).toBe(want.width);
        expect(got.height, `rect ${rect}`).toBe(want.height);
        expect(got.data, `rect ${rect}`).toEqual(want.data);
      }
      // ...and the frame must not be served for a DIFFERENT document version.
      const edited = await state.applyOps(
        [{ kind: "set_props", payload: { layerId: "L2", props: { visible: false } } }] as never[],
        doc,
      );
      const got = await state.region(edited, [10, 17, 99, 143]);
      const want = await renderRegion(edited, [10, 17, 99, 143], state.ctx);
      expect(got.data).toEqual(want.data);
    });

    it("still applies ops correctly and previews the result", async () => {
      const { doc, store } = await lazy(makeDoc());
      const state = new DocRenderState(store, { tileSize: TILE, pixelCacheBytes: TINY });
      const edited = await state.applyOps(
        [{ kind: "set_props", payload: { layerId: "L1", props: { visible: false } } }] as never[],
        doc,
      );
      const got = await state.composite(edited);
      const want = await render(edited, state.ctx);
      expect(got.data).toEqual(want.data);
    });

    it("crossing the threshold mid-life switches paths without changing output", async () => {
      const { doc, store } = await lazy(makeDoc());
      // Budget sits between "one layer" and "all layers": the full doc is not
      // tileable, but removing a layer brings it under.
      const state = new DocRenderState(store, { tileSize: TILE, pixelCacheBytes: 130 * 1024 });
      const before = await state.composite(doc);
      expect(before.data).toEqual((await render(doc, state.ctx)).data);

      const smaller = await state.applyOps(
        [{ kind: "remove_layer", payload: { layerId: "L1" } }] as never[],
        doc,
      );
      const after = await state.composite(smaller);
      expect(after.data).toEqual((await render(smaller, state.ctx)).data);
    });
  });

  it("survives a tile budget too small to hold the grid", async () => {
    const { doc, store } = await lazy(makeDoc());
    const state = new DocRenderState(store, {
      tileSize: TILE,
      tileCacheBytes: 2 * TILE * TILE * 4,
      checkpointBytes: 2 * TILE * TILE * 4,
    });
    const got = await state.composite(doc);
    const want = await render(doc, state.ctx);
    expect(got.data).toEqual(want.data);
    expect(state.cacheBytes.tiles).toBeLessThanOrEqual(2 * TILE * TILE * 4);
  });
});
