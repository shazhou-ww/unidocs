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
  it("crops the composite to a rect", async () => {
    const out = await renderRegion(doc, [0, 1, 1, 2]); // right pixel
    expect(out.width).toBe(1); expect(out.height).toBe(1);
    expect([...out.data]).toEqual([0, 0, 255, 255]);
  });
});

describe("renderLayer", () => {
  it("renders a single layer cropped to its bounds", async () => {
    const out = await renderLayer(doc, "blue");
    expect(out.width).toBe(1); expect(out.height).toBe(1);
    expect([...out.data]).toEqual([0, 0, 255, 255]);
  });
});

describe("downscale", () => {
  it("shrinks so the longer side is at most maxSize", async () => {
    const px = { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) };
    const out = downscale(px, 2);
    expect(out.width).toBe(2); expect(out.height).toBe(1);
  });
  it("is a no-op when already small", async () => {
    const px = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
    expect(downscale(px, 768)).toBe(px);
  });
});

// Regression: renderLayer used to whitelist the isolatable types as
// `raster || group`. When import started retyping layers that carry text /
// vector / placed metadata as "text" / "fill" / "smartObject", those layers
// silently stopped being isolatable and `query_layer_image` began returning
// the COMPOSITED BACKDROP cropped to the layer's bounds instead of the layer
// on a transparent backdrop. Only `adjustment` genuinely has no standalone
// pixels; every other type goes through applyLayer's type-agnostic
// `layer.pixels` branch.
describe("renderLayer isolation across layer types", () => {
  // Opaque red underneath, half-transparent blue on top. Isolated, the top
  // layer must read as its own [0,0,255,128]; composited over red it would
  // read as the flattened [127,0,128,255].
  const bg: Layer = { id: "bg", type: "raster", name: "bg", bounds: [0, 0, 1, 1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: { width: 1, height: 1, data: fill(1, 1, [255, 0, 0, 255]) } };
  const topOf = (type: Layer["type"]): Layer => ({
    id: "top", type, name: "top", bounds: [0, 0, 1, 1], opacity: 1, blendMode: "normal",
    visible: true, locked: false, clipping: false,
    pixels: { width: 1, height: 1, data: fill(1, 1, [0, 0, 255, 128]) },
  });
  const stack = (type: Layer["type"]): PsdDoc => ({
    canvas: { width: 1, height: 1, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [bg, topOf(type)],
  });

  for (const type of ["raster", "fill", "text", "smartObject"] as const) {
    it(`renders a "${type}" layer in isolation, not composited over the backdrop`, async () => {
      const out = await renderLayer(stack(type), "top");
      expect([...out.data]).toEqual([0, 0, 255, 128]);
    });
  }

  it("still falls back to the composite for an adjustment layer, which has no standalone pixels", async () => {
    const adj: Layer = {
      id: "adj", type: "adjustment", name: "adj", bounds: [0, 0, 1, 1], opacity: 1,
      blendMode: "normal", visible: true, locked: false, clipping: false,
      adjustType: "brit", params: { brightness: 0, contrast: 0 },
    };
    const out = await renderLayer({
      canvas: { width: 1, height: 1, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
      layers: [bg, adj],
    }, "adj");
    expect([...out.data]).toEqual([255, 0, 0, 255]);
  });

  it("honours context:true by compositing even an isolatable layer over its backdrop", async () => {
    const out = await renderLayer(stack("fill"), "top", { context: true });
    expect([...out.data]).toEqual([127, 0, 128, 255]);
  });
});
