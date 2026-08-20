import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=r; d[i*4+1]=g; d[i*4+2]=b; d[i*4+3]=a; }
  return d;
}
const doc = (w: number, h: number, layers: Layer[]): PsdDoc => ({ canvas: { width: w, height: h, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers });
const px = (out: { data: Uint8ClampedArray }, i: number) => [out.data[i*4], out.data[i*4+1], out.data[i*4+2], out.data[i*4+3]];

describe("layer mask", () => {
  it("hides pixels where the mask is black, shows where white", () => {
    // 4x1 red layer; mask channel 0 = [0,0,255,255] → left two hidden, right two shown.
    const red: Layer = {
      id: "r", type: "raster", name: "r", bounds: [0, 0, 1, 4], opacity: 1,
      blendMode: "normal", visible: true, locked: false, clipping: false,
      pixels: { width: 4, height: 1, data: fill(4, 1, [255, 0, 0, 255]) },
      mask: {
        pixels: { width: 4, height: 1, data: new Uint8ClampedArray([0,0,0,255, 0,0,0,255, 255,255,255,255, 255,255,255,255]) },
        bounds: [0, 0, 1, 4], defaultColor: 255, inverted: false,
      },
    };
    const out = render(doc(4, 1, [red]));
    expect(px(out, 0)[3]).toBe(0);           // masked → transparent
    expect(px(out, 1)[3]).toBe(0);
    expect(px(out, 3)).toEqual([255, 0, 0, 255]); // unmasked → red
  });

  it("defaultColor fills outside the mask rect", () => {
    // Mask rect covers only pixel 0; defaultColor 0 hides everything else.
    const red: Layer = {
      id: "r", type: "raster", name: "r", bounds: [0, 0, 1, 4], opacity: 1,
      blendMode: "normal", visible: true, locked: false, clipping: false,
      pixels: { width: 4, height: 1, data: fill(4, 1, [255, 0, 0, 255]) },
      mask: {
        pixels: { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) },
        bounds: [0, 0, 1, 1], defaultColor: 0, inverted: false,
      },
    };
    const out = render(doc(4, 1, [red]));
    expect(px(out, 0)).toEqual([255, 0, 0, 255]); // inside rect, white → shown
    expect(px(out, 1)[3]).toBe(0);                // outside rect, default 0 → hidden
    expect(px(out, 3)[3]).toBe(0);
  });
});

describe("blend modes (previously fell back to normal)", () => {
  it("difference inverts the backdrop", () => {
    // white backdrop, white source at difference → |1-1| = 0 (black).
    const back: Layer = {
      id: "b", type: "raster", name: "b", bounds: [0, 0, 1, 1], opacity: 1,
      blendMode: "normal", visible: true, locked: false, clipping: false,
      pixels: { width: 1, height: 1, data: fill(1, 1, [255, 255, 255, 255]) },
    };
    const top: Layer = {
      id: "t", type: "raster", name: "t", bounds: [0, 0, 1, 1], opacity: 1,
      blendMode: "difference", visible: true, locked: false, clipping: false,
      pixels: { width: 1, height: 1, data: fill(1, 1, [255, 255, 255, 255]) },
    };
    const out = render(doc(1, 1, [back, top]));
    expect(px(out, 0)).toEqual([0, 0, 0, 255]);
  });
});
