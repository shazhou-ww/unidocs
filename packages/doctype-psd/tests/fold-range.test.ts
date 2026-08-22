import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { renderRegionDirect } from "../src/render/region.js";
import { foldRange, type Target } from "../src/render/composite.js";

// Fixture mirrors incremental-random's makeDoc: bg + multiply raster + a
// clipping layer (index 2) confined to r1's alpha + an adjustment (index 3) +
// a group (index 4) + a drop-shadow raster (index 5). N = 6 top-level layers,
// so the split boundary A sweeps a clipping layer, an adjustment, and a group.
function fill(w: number, h: number, rgba: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=rgba[0]; d[i*4+1]=rgba[1]; d[i*4+2]=rgba[2]; d[i*4+3]=rgba[3]; }
  return d;
}
const canvas = { width: 100, height: 100, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };
const raster = (id: string, b: [number,number,number,number], rgba: number[], over: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds: b, opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
  pixels: { width: b[3]-b[1], height: b[2]-b[0], data: fill(b[3]-b[1], b[2]-b[0], rgba) }, ...over,
});
function makeDoc(): PsdDoc { return { canvas, layers: [
  raster("bg", [0,0,100,100], [20,30,40,255]),
  raster("r1", [10,10,50,50], [255,0,0,180], { blendMode: "multiply" }),
  raster("clp", [10,10,50,50], [0,0,255,255], { clipping: true }),
  { id:"adj", type:"adjustment", name:"adj", bounds:[0,0,100,100], opacity:1, blendMode:"normal", visible:true, locked:false, clipping:false, adjustType:"brit", params:{ brightness:0.05, contrast:0.1 } },
  { id:"grp", type:"group", name:"grp", bounds:[0,0,100,100], opacity:0.9, blendMode:"normal", visible:true, locked:false, clipping:false,
    children:[ raster("gc", [60,10,90,40], [200,200,0,255]) ] },
  raster("r2", [55,55,90,90], [0,200,0,255], { dropShadow:{ color:{r:0,g:0,b:0}, opacity:0.6, blendMode:"normal", angle:135, distance:5, size:3, choke:0 } }),
]}; }

type Rect = [number, number, number, number]; // [top,left,bottom,right]
function zeroTarget(region: Rect): Target {
  const [t,l,b,r] = region; const w = r-l, h = b-t;
  return { data: new Uint8ClampedArray(w*h*4), originX: l, originY: t, width: w, height: h };
}
const bytes = (a: Uint8ClampedArray) => [...a];

const doc = makeDoc();
const N = doc.layers.length; // 6

// Full canvas + sub-regions: the clip region, the shadow region, quadrants.
const REGIONS: Rect[] = [
  [0, 0, 100, 100],   // full
  [0, 0, 50, 50],     // bg + r1/clp overlap
  [10, 10, 50, 50],   // exactly the clipping pair's region
  [55, 55, 90, 90],   // r2 + its drop shadow
  [50, 50, 100, 100], // bottom-right quadrant
];

describe("foldRange", () => {
  for (const region of REGIONS) {
    it(`fold[0,N) from zero acc ≡ renderRegionDirect — region ${region.join(",")}`, async () => {
      const tgt = zeroTarget(region);
      await foldRange(tgt, doc, 0, N);
      const oracle = await renderRegionDirect(doc, region);
      expect(bytes(tgt.data)).toEqual([...oracle.data]);
    });

    it(`split fold[0,A)+fold[A,N) ≡ fold[0,N) for every A (incl. clip/adjustment/group boundaries) — region ${region.join(",")}`, async () => {
      const whole = zeroTarget(region);
      await foldRange(whole, doc, 0, N);
      for (let A = 0; A <= N; A++) {
        const t = zeroTarget(region);
        await foldRange(t, doc, 0, A);
        await foldRange(t, doc, A, N);
        expect({ A, data: bytes(t.data) }).toEqual({ A, data: bytes(whole.data) });
      }
    });
  }
});

// Clip-base PROMOTION shapes: a visible clipping layer that enters its turn
// with a null base applies UNCONFINED and then becomes the clip base for the
// clipping layers above it. The start-boundary base scan must reproduce that
// (a naive "skip clipping, find nearest non-clipping base" scan leaves the
// upper clip layer unconfined and diverges). Each doc's split[0,A)+[A,M) must
// equal fold[0,M) for every A — the sharp cases are A landing inside the clip
// run whose base was promoted (or absent).
const promoDocs: { name: string; doc: PsdDoc }[] = [
  {
    // Hidden non-clipping base below a 2-layer clip run: clipA (below base
    // hidden) promotes to base; clipB is confined to clipA's [10,50) box.
    name: "hidden base + clipA promotes + clipB confined",
    doc: { canvas, layers: [
      raster("base", [0,0,100,100], [200,200,200,255], { visible: false }),
      raster("clipA", [10,10,50,50], [255,0,0,255], { clipping: true }),
      raster("clipB", [0,0,100,100], [0,200,0,255], { clipping: true }),
    ] },
  },
  {
    // Bottom-of-stack clip run with NO base at all: clipA promotes, clipB
    // confined to it.
    name: "bottom-of-stack clip run (no base)",
    doc: { canvas, layers: [
      raster("clipA", [10,10,50,50], [255,0,0,255], { clipping: true }),
      raster("clipB", [0,0,100,100], [0,200,0,255], { clipping: true }),
      raster("top", [0,0,100,100], [0,0,200,120]),
    ] },
  },
  {
    // Adjustment-as-base variant: an adjustment is not a clip base (→ null),
    // so clipA below it promotes and confines clipB.
    name: "adjustment (not a base) + clipA promotes + clipB confined",
    doc: { canvas, layers: [
      raster("bg", [0,0,100,100], [30,40,50,255]),
      { id:"adj", type:"adjustment", name:"adj", bounds:[0,0,100,100], opacity:1, blendMode:"normal", visible:true, locked:false, clipping:false, adjustType:"brit", params:{ brightness:0.05, contrast:0.1 } },
      raster("clipA", [10,10,50,50], [255,0,0,255], { clipping: true }),
      raster("clipB", [0,0,100,100], [0,200,0,255], { clipping: true }),
    ] },
  },
];

describe("foldRange clip-base promotion (split parity for every A)", () => {
  for (const { name, doc: pdoc } of promoDocs) {
    const M = pdoc.layers.length;
    for (const region of [[0,0,100,100], [0,0,50,50], [10,10,50,50]] as Rect[]) {
      it(`${name} — split≡whole for every A — region ${region.join(",")}`, async () => {
        const whole = zeroTarget(region);
        await foldRange(whole, pdoc, 0, M);
        // fold[0,M) must also match the region-direct oracle.
        const oracle = await renderRegionDirect(pdoc, region);
        expect(bytes(whole.data)).toEqual([...oracle.data]);
        for (let A = 0; A <= M; A++) {
          const t = zeroTarget(region);
          await foldRange(t, pdoc, 0, A);
          await foldRange(t, pdoc, A, M);
          expect({ A, data: bytes(t.data) }).toEqual({ A, data: bytes(whole.data) });
        }
      });
    }
  }
});
