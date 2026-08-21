import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { renderRegion } from "../src/render/index.js";
import { renderRegionDirect } from "../src/render/region.js";
import { load } from "../src/psd/load.js";

function fill(w: number, h: number, rgba: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=rgba[0]; d[i*4+1]=rgba[1]; d[i*4+2]=rgba[2]; d[i*4+3]=rgba[3]; }
  return d;
}
const raster = (id: string, bounds: [number,number,number,number], rgba: number[], over: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds, opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false,
  pixels: { width: bounds[3]-bounds[1], height: bounds[2]-bounds[0], data: fill(bounds[3]-bounds[1], bounds[2]-bounds[0], rgba) },
  ...over,
});
const canvas = { width: 20, height: 20, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

// A doc exercising: opacity/blend, drop shadow (bleeds outside bounds),
// stroke, a masked adjustment, a group, and a clipping layer.
const shadowLayer = raster("sh", [8, 8, 12, 12], [255,0,0,255], {
  // angle 135 → composite.ts offset dx=round(-4·cos135)=+3, dy=round(4·sin135)=+3
  // (shadow falls down-right of the fill). influence ≈ [8,8,17,17].
  dropShadow: { color:{r:0,g:0,b:0}, opacity:0.8, blendMode:"normal", angle:135, distance:4, size:2, choke:0 },
});
const doc: PsdDoc = {
  canvas,
  layers: [
    raster("bg", [0,0,20,20], [10,20,30,255]),
    raster("mid", [4,4,10,10], [0,255,0,128], { opacity: 0.6, blendMode: "multiply" }),
    shadowLayer,
    { id:"adj", type:"adjustment", name:"adj", bounds:[0,0,20,20], opacity:1, blendMode:"normal", visible:true, locked:false, clipping:false, adjustType:"brit", params:{ brightness:0.1, contrast:0.2 } },
    { id:"grp", type:"group", name:"grp", bounds:[0,0,20,20], opacity:0.9, blendMode:"normal", visible:true, locked:false, clipping:false, children:[ raster("gc", [14,14,18,18], [0,0,255,255]) ] },
  ],
};

const REGIONS: [number,number,number,number][] = [
  [0,0,20,20],   // full
  [0,0,10,10],   // top-left quadrant
  [10,10,20,20], // bottom-right quadrant
  [12,12,14,14], // OUTSIDE shadowLayer's fill [8,8,12,12] but INSIDE its shadow bleed [8,8,17,17]
                 // (forces renderRegionDirect to NOT skip the shadow layer here); avoids group child [14,14,..]
  [4,4,10,10],   // exactly the multiply layer
];

describe("renderRegionDirect ≡ renderRegion (parity oracle)", () => {
  for (const region of REGIONS) {
    it(`region ${region.join(",")}`, async () => {
      const oracle = await renderRegion(doc, region);
      const direct = await renderRegionDirect(doc, region);
      expect(direct.width).toBe(oracle.width);
      expect(direct.height).toBe(oracle.height);
      expect([...direct.data]).toEqual([...oracle.data]);
    });
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));

describe("renderRegionDirect ≡ renderRegion on sample.psd", () => {
  it("matches across a grid of regions", async () => {
    const bytes = readFileSync(path.resolve(here, "fixtures/sample.psd"));
    const psd = await load(new Uint8Array(bytes));
    const { width: W, height: H } = psd.canvas;
    const regions: [number,number,number,number][] = [];
    for (const [t,l] of [[0,0],[0,W>>1],[H>>1,0],[H>>1,W>>1]]) {
      regions.push([t, l, Math.min(H, t + (H>>1)), Math.min(W, l + (W>>1))]);
    }
    for (const region of regions) {
      const oracle = await renderRegion(psd, region);
      const direct = await renderRegionDirect(psd, region);
      expect([...direct.data]).toEqual([...oracle.data]);
    }
  });
});
