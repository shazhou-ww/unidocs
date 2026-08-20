import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=r; d[i*4+1]=g; d[i*4+2]=b; d[i*4+3]=a; }
  return d;
}
const base = (overrides: Partial<Layer>): Layer => ({
  id: "x", type: "raster", name: "x", bounds: [0, 0, 4, 4], opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false,
  pixels: { width: 4, height: 4, data: fill(4, 4, [255, 255, 255, 255]) }, ...overrides,
});
const docWith = (layer: Layer): PsdDoc => ({
  canvas: { width: 4, height: 4, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [layer],
});
const alphaAt = (px: { width: number; data: Uint8ClampedArray }, x: number, y: number) => px.data[(y * px.width + x) * 4 + 3];
const rgbAt = (px: { width: number; data: Uint8ClampedArray }, x: number, y: number) => [...px.data.slice((y*px.width+x)*4, (y*px.width+x)*4 + 3)];

describe("fillOpacity", () => {
  it("fillOpacity:0 makes the fill fully transparent", async () => {
    const out = await render(docWith(base({ fillOpacity: 0 })));
    for (let i = 0; i < 4 * 4; i++) expect(out.data[i * 4 + 3]).toBe(0);
  });
  it("fillOpacity:0.5 halves the fill alpha", async () => {
    const out = await render(docWith(base({ fillOpacity: 0.5 })));
    expect(alphaAt(out, 2, 2)).toBe(128);
  });
  it("absent fillOpacity keeps a fully opaque fill", async () => {
    const out = await render(docWith(base({})));
    expect(alphaAt(out, 2, 2)).toBe(255);
  });
});

describe("stroke effect", () => {
  it("inside stroke on a fill:0 layer draws a border, interior stays transparent", async () => {
    const out = await render(docWith(base({
      fillOpacity: 0,
      stroke: { color: { r: 128, g: 128, b: 128 }, opacity: 1, size: 1, position: "inside", blendMode: "normal" },
    })));
    // corner is on the inner-edge band → gray, opaque
    expect(alphaAt(out, 0, 0)).toBe(255);
    expect(rgbAt(out, 0, 0)).toEqual([128, 128, 128]);
    // centre is >1px from the edge and fill is 0 → transparent
    expect(alphaAt(out, 2, 2)).toBe(0);
  });
});
