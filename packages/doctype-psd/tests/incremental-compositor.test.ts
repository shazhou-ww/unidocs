import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";
import { applyOne } from "../src/ops/index.js";
import { IncrementalCompositor } from "../src/render/incremental.js";

function fill(w: number, h: number, rgba: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=rgba[0]; d[i*4+1]=rgba[1]; d[i*4+2]=rgba[2]; d[i*4+3]=rgba[3]; }
  return d;
}
const canvas = { width: 96, height: 96, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };
const raster = (id: string, b: [number,number,number,number], rgba: number[], over: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds: b, opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false,
  pixels: { width: b[3]-b[1], height: b[2]-b[0], data: fill(b[3]-b[1], b[2]-b[0], rgba) }, ...over,
});
const base: PsdDoc = { canvas, layers: [
  raster("bg", [0,0,96,96], [20,30,40,255]),
  raster("red", [8,8,40,40], [255,0,0,200], { blendMode: "multiply" }),
  raster("clp", [8,8,40,40], [0,0,255,255], { clipping: true }), // clips to red (its base) — exercises clip-base coupling
  raster("grn", [50,50,80,80], [0,255,0,255], { dropShadow: { color:{r:0,g:0,b:0}, opacity:0.7, blendMode:"normal", angle:135, distance:5, size:3, choke:0 } }),
]};

// A fixed op sequence exercising set_props, transform, add, remove, reorder.
const ops = [
  { kind: "set_props", payload: { layerId: "red", props: { opacity: 0.4 } } },
  { kind: "set_props", payload: { layerId: "grn", props: { visible: false } } },
  { kind: "set_props", payload: { layerId: "grn", props: { visible: true } } },
  { kind: "transform", payload: { layerId: "red", op: { translate: [20, 12] } } }, // translate is a [dx,dy] tuple
  { kind: "reorder", payload: { layerId: "red", parentId: null, index: 0 } },       // parentId required (null = top level)
  { kind: "remove_layer", payload: { layerId: "grn" } },
];

const bytes = (p: { data: Uint8ClampedArray }) => [...p.data];

describe("IncrementalCompositor ≡ render(doc) across an op sequence", () => {
  it("matches full render after each op (tileSize 40, partial edge tiles)", async () => {
    const comp = new IncrementalCompositor(base, { tileSize: 40 });
    // initial frame
    expect(bytes(await comp.composite())).toEqual(bytes(await render(base)));
    let doc = base;
    for (const op of ops) {
      await comp.applyOp(op as any);
      doc = applyOne(doc, op as any);
      expect(bytes(await comp.composite())).toEqual(bytes(await render(doc)));
    }
  });

  it("only dirty tiles are recomputed (cache reuse)", async () => {
    const comp = new IncrementalCompositor(base, { tileSize: 40 });
    await comp.composite();                       // warm all tiles
    const dirty = await comp.applyOp({ kind: "set_props", payload: { layerId: "red", props: { opacity: 0.5 } } } as any);
    // red influence [8,8,40,40] → dirty rect within top-left; a far tile stays byte-equal to full render
    const full = await render(comp.doc);
    expect(bytes(await comp.composite())).toEqual(bytes(full));
    expect(dirty[0]).toBeLessThan(dirty[2]); // non-empty rect
  });

  it("reuses cached tiles outside the dirty rect (identity), recomputes dirty ones", async () => {
    const comp = new IncrementalCompositor(base, { tileSize: 40 });
    await comp.composite(); // warm all tiles
    // a far tile clearly outside `red`'s influence [8,8,40,40] — bottom-right
    const farTx = 2, farTy = 2;   // tile origin (80,80) on the 96x96 canvas
    const dirtyTx = 0, dirtyTy = 0;
    const farBefore = await comp.readTile(farTx, farTy);
    const dirtyBefore = await comp.readTile(dirtyTx, dirtyTy);
    await comp.applyOp({ kind: "set_props", payload: { layerId: "red", props: { opacity: 0.3 } } } as any);
    expect(await comp.readTile(farTx, farTy)).toBe(farBefore);        // untouched → same reference (reused)
    expect(await comp.readTile(dirtyTx, dirtyTy)).not.toBe(dirtyBefore); // invalidated → recomputed (new object)
  });
});

describe("below-checkpoint reuse across edits to the same active layer", () => {
  // grn is the top-most layer (index 3); red is a lower layer (index 1).
  const setOpacity = (layerId: string, opacity: number) =>
    ({ kind: "set_props", payload: { layerId, props: { opacity } } });

  it("does not rebuild belowChk on consecutive edits to the same layer, but rebuilds when the active layer changes", async () => {
    const comp = new IncrementalCompositor(base, { tileSize: 40 });
    await comp.composite(); // warm all tiles (activeIndex starts at 0)

    // First edit to a high-index layer L=grn → activeIndex moves to 3, belowChk discarded.
    await comp.applyOp(setOpacity("grn", 0.9) as any);
    await comp.composite();
    const r1 = comp._belowRebuilds;

    // Second edit to the SAME layer L=grn → activeIndex unchanged, belowChk reused.
    await comp.applyOp(setOpacity("grn", 0.8) as any);
    await comp.composite();
    const r2 = comp._belowRebuilds;
    expect(r2).toBe(r1); // no belowChk rebuild while the active layer is stable

    // Switch the active layer to M=red (a lower index) → belowChk discarded, rebuilt.
    await comp.applyOp(setOpacity("red", 0.7) as any);
    await comp.composite();
    const r3 = comp._belowRebuilds;
    expect(r3).toBeGreaterThan(r2); // active-layer change forces a below rebuild
  });

  it("stays byte-identical to render(doc) while reusing the checkpoint", async () => {
    const comp = new IncrementalCompositor(base, { tileSize: 40 });
    await comp.composite();
    let doc = base;
    for (const op of [setOpacity("grn", 0.9), setOpacity("grn", 0.8), setOpacity("grn", 0.6), setOpacity("red", 0.5)]) {
      await comp.applyOp(op as any);
      doc = applyOne(doc, op as any);
      expect(bytes(await comp.composite())).toEqual(bytes(await render(doc)));
    }
  });
});
