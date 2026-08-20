import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=r; d[i*4+1]=g; d[i*4+2]=b; d[i*4+3]=a; }
  return d;
}
const solid = (id: string, w: number, h: number, rgba: number[], opts: Partial<{ top: number; left: number; opacity: number; blendMode: string; visible: boolean }> = {}): Layer => ({
  id, type: "raster", name: id,
  bounds: [opts.top ?? 0, opts.left ?? 0, (opts.top ?? 0) + h, (opts.left ?? 0) + w],
  opacity: opts.opacity ?? 1, blendMode: (opts.blendMode ?? "normal") as any,
  visible: opts.visible ?? true, locked: false, clipping: false,
  pixels: { width: w, height: h, data: fill(w, h, rgba) },
});
const doc = (w: number, h: number, layers: Layer[]): PsdDoc => ({ canvas: { width: w, height: h, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers });

describe("render (software compositor)", () => {
  it("opaque layer over transparent", async () => {
    const { data } = await render(doc(1, 1, [solid("a", 1, 1, [255, 0, 0, 255])]));
    expect([...data]).toEqual([255, 0, 0, 255]);
  });

  it("50% layer over opaque backdrop blends (normal)", async () => {
    const { data } = await render(doc(1, 1, [solid("b", 1, 1, [0, 0, 255, 255]), solid("r", 1, 1, [255, 0, 0, 255], { opacity: 0.5 })]));
    expect([...data]).toEqual([128, 0, 128, 255]);
  });

  it("multiply blend: red × white = red", async () => {
    const { data } = await render(doc(1, 1, [solid("w", 1, 1, [255, 255, 255, 255]), solid("r", 1, 1, [255, 0, 0, 255], { blendMode: "multiply" })]));
    expect([...data]).toEqual([255, 0, 0, 255]);
  });

  it("brightness adjustment raises value", async () => {
    const adj: Layer = { id: "adj", type: "adjustment", name: "adj", adjustType: "brit", params: { brightness: 0.2 }, bounds: [0,0,1,1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false };
    const { data } = await render(doc(1, 1, [solid("g", 1, 1, [128, 128, 128, 255]), adj]));
    expect(data[0]).toBeGreaterThan(170);
    expect(data[0]).toBeLessThan(185);
  });

  it("invisible layer is skipped", async () => {
    const { data } = await render(doc(1, 1, [solid("a", 1, 1, [255, 0, 0, 255], { visible: false })]));
    expect([...data]).toEqual([0, 0, 0, 0]);
  });

  it("layer only affects its bounds region", async () => {
    const { data } = await render(doc(2, 1, [solid("a", 1, 1, [255, 0, 0, 255], { left: 1, top: 0 })]));
    expect([...data.slice(0, 4)]).toEqual([0, 0, 0, 0]);   // (0,0) untouched
    expect([...data.slice(4, 8)]).toEqual([255, 0, 0, 255]); // (1,0) red
  });
});
