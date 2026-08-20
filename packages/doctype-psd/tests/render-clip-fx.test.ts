import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=r; d[i*4+1]=g; d[i*4+2]=b; d[i*4+3]=a; }
  return d;
}
const layer = (id: string, w: number, h: number, rgba: number[], extra: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds: [0, 0, h, w], opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false, pixels: { width: w, height: h, data: fill(w, h, rgba) }, ...extra,
});
const doc = (w: number, h: number, layers: Layer[]): PsdDoc => ({ canvas: { width: w, height: h, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers });
const px = (out: { data: Uint8ClampedArray }, i: number) => [out.data[i*4], out.data[i*4+1], out.data[i*4+2], out.data[i*4+3]];

describe("clipping mask", () => {
  it("confines a clipped layer to the base layer's alpha", () => {
    // 3-wide canvas. Base rectangle covers only pixel 0 (alpha there, transparent elsewhere).
    // A full-width red layer clipped to it should show only at pixel 0.
    const base: Layer = {
      id: "base", type: "raster", name: "base", bounds: [0, 0, 1, 1], opacity: 1, blendMode: "normal",
      visible: true, locked: false, clipping: false, pixels: { width: 1, height: 1, data: fill(1, 1, [255, 255, 255, 255]) },
    };
    const clipped: Layer = { ...layer("red", 3, 1, [255, 0, 0, 255]), clipping: true };
    const out = render(doc(3, 1, [base, clipped]));
    expect(px(out, 0)).toEqual([255, 0, 0, 255]); // over the base → shown
    expect(px(out, 1)[3]).toBe(0);                // outside base → clipped away
    expect(px(out, 2)[3]).toBe(0);
  });
});

describe("color overlay effect", () => {
  it("replaces the layer colour within its alpha", () => {
    // Black shape + gold Color Overlay → renders gold, keeping the shape's alpha.
    const shape = layer("s", 1, 1, [0, 0, 0, 255], { colorOverlay: { r: 156, g: 137, b: 78, opacity: 1 } });
    const out = render(doc(1, 1, [shape]));
    expect(px(out, 0)).toEqual([156, 137, 78, 255]);
  });
});
