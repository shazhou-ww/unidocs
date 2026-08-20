import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { renderRegion, renderLayer, downscale } from "../src/render/index.js";

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=r; d[i*4+1]=g; d[i*4+2]=b; d[i*4+3]=a; }
  return d;
}
// 2x1 canvas: pixel 0 red, pixel 1 blue (two 1x1 layers side by side).
const red: Layer = { id: "red", type: "raster", name: "red", bounds: [0, 0, 1, 1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: { width: 1, height: 1, data: fill(1, 1, [255, 0, 0, 255]) } };
const blue: Layer = { id: "blue", type: "raster", name: "blue", bounds: [0, 1, 1, 2], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: { width: 1, height: 1, data: fill(1, 1, [0, 0, 255, 255]) } };
const doc: PsdDoc = { canvas: { width: 2, height: 1, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [red, blue] };

describe("renderRegion", () => {
  it("crops the composite to a rect", () => {
    const out = renderRegion(doc, [0, 1, 1, 2]); // right pixel
    expect(out.width).toBe(1); expect(out.height).toBe(1);
    expect([...out.data]).toEqual([0, 0, 255, 255]);
  });
});

describe("renderLayer", () => {
  it("renders a single layer cropped to its bounds", () => {
    const out = renderLayer(doc, "blue");
    expect(out.width).toBe(1); expect(out.height).toBe(1);
    expect([...out.data]).toEqual([0, 0, 255, 255]);
  });
});

describe("downscale", () => {
  it("shrinks so the longer side is at most maxSize", () => {
    const px = { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) };
    const out = downscale(px, 2);
    expect(out.width).toBe(2); expect(out.height).toBe(1);
  });
  it("is a no-op when already small", () => {
    const px = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
    expect(downscale(px, 768)).toBe(px);
  });
});
