import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=r; d[i*4+1]=g; d[i*4+2]=b; d[i*4+3]=a; }
  return d;
}
const rgbaAt = (px: { width: number; data: Uint8ClampedArray }, x: number, y: number) =>
  [...px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 4)];

// 8x8 canvas, a 2x2 opaque white square at rows/cols 2..3.
const square = (overrides: Partial<Layer>): Layer => ({
  id: "s", type: "raster", name: "s", bounds: [2, 2, 4, 4], opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false,
  pixels: { width: 2, height: 2, data: fill(2, 2, [255, 255, 255, 255]) }, ...overrides,
});
const doc = (l: Layer): PsdDoc => ({ canvas: { width: 8, height: 8, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [l] });

describe("drop shadow", () => {
  it("offsets a hard-edged coloured copy behind the layer", () => {
    // angle 90° (light from top) → shadow cast straight down by `distance`.
    const out = render(doc(square({
      dropShadow: { color: { r: 255, g: 0, b: 0 }, opacity: 1, blendMode: "normal", angle: 90, distance: 2, size: 0, choke: 0 },
    })));
    // layer fill still at its own rows (2..3)
    expect(rgbaAt(out, 2, 2)).toEqual([255, 255, 255, 255]);
    // shadow appears 2 rows down (rows 4..5), red, opaque
    expect(rgbaAt(out, 2, 4)).toEqual([255, 0, 0, 255]);
    expect(rgbaAt(out, 3, 5)).toEqual([255, 0, 0, 255]);
    // untouched pixel stays transparent
    expect(rgbaAt(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("blurred shadow (size>0) softens beyond the shape edge", () => {
    // No offset, size 1 blur → shadow bleeds one ring outside the 2x2 square,
    // proving the bounds-local blur buffer works (the ring is 0 without blur).
    const out = render(doc(square({
      dropShadow: { color: { r: 255, g: 0, b: 0 }, opacity: 1, blendMode: "normal", angle: 0, distance: 0, size: 1, choke: 0 },
    })));
    // pixel just outside the square (row 1, col 2) picks up faint red from blur
    const [r, , , a] = rgbaAt(out, 2, 1);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
    expect(r).toBeGreaterThan(0);
  });
});
