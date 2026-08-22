import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";
import { applyOne, type PsdOp } from "../src/ops/index.js";
import { IncrementalCompositor } from "../src/render/incremental.js";

function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

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

// Deterministic op stream over the fixture's layer ids (recursing into group children).
function allIds(layers: Layer[]): string[] {
  const out: string[] = [];
  for (const l of layers) { out.push(l.id); if (l.children) out.push(...allIds(l.children)); }
  return out;
}
function genOp(rng: () => number, doc: PsdDoc, n: number): PsdOp {
  const ids = allIds(doc.layers);
  const id = ids[Math.floor(rng() * ids.length)];
  const kinds = ["opacity","visible","blend","translate","reorder","adjust","mask","add","remove"] as const;
  const k = kinds[Math.floor(rng() * kinds.length)];
  switch (k) {
    case "opacity": return { kind:"set_props", payload:{ layerId:id, props:{ opacity: Math.round(rng()*100)/100 } } };
    case "visible": return { kind:"set_props", payload:{ layerId:id, props:{ visible: rng()>0.5 } } };
    case "blend":   return { kind:"set_props", payload:{ layerId:id, props:{ blendMode: rng()>0.5?"screen":"normal" } } };
    case "translate": return { kind:"transform", payload:{ layerId:id, op:{ translate:[Math.floor(rng()*20)-10, Math.floor(rng()*20)-10] } } };
    case "reorder": return { kind:"reorder", payload:{ layerId:id, parentId:null, index: Math.floor(rng()*doc.layers.length) } };
    case "adjust":  return { kind:"adjust", payload:{ layerId:"adj", params:{ brightness: Math.round((rng()*0.4-0.2)*100)/100, contrast: Math.round((rng()*0.4-0.2)*100)/100 } } };
    case "mask":    return rng()>0.5
      ? { kind:"mask_edit", payload:{ layerId:id, mask:null } }
      : { kind:"mask_edit", payload:{ layerId:id, mask:{ pixels:{ width:20, height:20, data: fill(20,20,[128,128,128,255]) }, bounds:[10,10,30,30], defaultColor:0, inverted:false } } };
    case "add":     return { kind:"add_layer", payload:{ layer: raster(`add${n}`, [(n*7)%80, (n*11)%80, (n*7)%80+15, (n*11)%80+15], [(n*40)%256,(n*70)%256,(n*90)%256,255]), parentId:null, index: Math.floor(rng()*(doc.layers.length+1)) } };
    case "remove":  return { kind:"remove_layer", payload:{ layerId:id } };
  }
}

const bytes = (p: { data: Uint8ClampedArray }) => [...p.data];

describe("IncrementalCompositor ≡ render — seeded random op sequences (adjustment+clip+group+effects)", () => {
  for (const seed of [1, 7, 42, 1234]) {
    it(`seed ${seed}: byte-parity after each of 40 random ops (tileSize 40, non-divisible)`, async () => {
      const rng = mulberry32(seed);
      let doc = makeDoc();
      const comp = new IncrementalCompositor(doc, { tileSize: 40 });
      expect(bytes(await comp.composite())).toEqual(bytes(await render(doc)));
      for (let n = 0; n < 40; n++) {
        const op = genOp(rng, doc, n);
        let next: PsdDoc;
        try { next = applyOne(doc, op); } catch { continue; } // skip ops the handler rejects (e.g. invalid reorder)
        await comp.applyOp(op);
        doc = next;
        expect(bytes(await comp.composite())).toEqual(bytes(await render(doc)));
      }
    });
  }

  it("crop mid-sequence keeps byte-parity (grid rebuild)", async () => {
    let doc = makeDoc();
    const comp = new IncrementalCompositor(doc, { tileSize: 40 });
    await comp.composite();
    for (const op of [
      { kind: "set_props", payload: { layerId: "r1", props: { opacity: 0.5 } } },
      { kind: "crop", payload: { rect: [0, 0, 60, 60] } },
      { kind: "set_props", payload: { layerId: "r2", props: { visible: false } } },
    ] as PsdOp[]) {
      let next: PsdDoc; try { next = applyOne(doc, op); } catch { continue; }
      await comp.applyOp(op); doc = next;
      expect(bytes(await comp.composite())).toEqual(bytes(await render(doc)));
    }
  });
});
