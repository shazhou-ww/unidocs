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
  it("matches full render after each op (tileSize 32)", async () => {
    const comp = new IncrementalCompositor(base, { tileSize: 32 });
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
    const comp = new IncrementalCompositor(base, { tileSize: 32 });
    await comp.composite();                       // warm all tiles
    const dirty = await comp.applyOp({ kind: "set_props", payload: { layerId: "red", props: { opacity: 0.5 } } } as any);
    // red influence [8,8,40,40] → dirty rect within top-left; a far tile stays byte-equal to full render
    const full = await render(comp.doc);
    expect(bytes(await comp.composite())).toEqual(bytes(full));
    expect(dirty[0]).toBeLessThan(dirty[2]); // non-empty rect
  });
});
