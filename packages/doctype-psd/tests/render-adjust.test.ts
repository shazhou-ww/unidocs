import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { render } from "../src/render/index.js";

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=r; d[i*4+1]=g; d[i*4+2]=b; d[i*4+3]=a; }
  return d;
}
const solid = (id: string, rgba: number[]): Layer => ({
  id, type: "raster", name: id, bounds: [0, 0, 1, 1], opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false, pixels: { width: 1, height: 1, data: fill(1, 1, rgba) },
});
const adj = (adjustType: string, params: Record<string, unknown>): Layer => ({
  id: "adj", type: "adjustment", name: "adj", adjustType, params, bounds: [0, 0, 1, 1],
  opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
});
const doc = (layers: Layer[]): PsdDoc => ({ canvas: { width: 1, height: 1, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers });
const px0 = (out: { data: Uint8ClampedArray }) => [out.data[0], out.data[1], out.data[2], out.data[3]];

describe("black & white adjustment", () => {
  it("maps a pure primary to its Photoshop-default gray weight", async () => {
    // Default red weight 40% → pure red becomes 0.4 gray ≈ 102, and R=G=B.
    const out = await render(doc([solid("bg", [255, 0, 0, 255]), adj("blwh", {})]));
    const [r, g, b] = px0(out);
    expect(r).toBe(g); expect(g).toBe(b);
    expect(r).toBeGreaterThan(95); expect(r).toBeLessThan(110);
  });

  it("respects custom channel weights", async () => {
    // Green weight 100% → pure green becomes ~1.0 (white).
    const out = await render(doc([solid("bg", [0, 255, 0, 255]), adj("blwh", { greens: 100 })]));
    expect(px0(out)[0]).toBeGreaterThan(250);
  });
});

describe("hue/saturation adjustment", () => {
  it("desaturates via master saturation -100", async () => {
    // Pure red → grayscale at its lightness (0.5) ≈ 128, equal channels.
    const out = await render(doc([solid("bg", [255, 0, 0, 255]), adj("hue2", { master: { saturation: -100 } })]));
    const [r, g, b] = px0(out);
    expect(r).toBe(g); expect(g).toBe(b);
    expect(r).toBeGreaterThan(120); expect(r).toBeLessThan(136);
  });

  it("colorize turns a gray into a hue", async () => {
    // Colorize hue 0 (red), saturation 100 on mid-gray → red.
    const out = await render(doc([solid("bg", [128, 128, 128, 255]), adj("hue2", { colorize: true, master: { hue: 0, saturation: 100, lightness: 0 } })]));
    const [r, g, b] = px0(out);
    expect(r).toBeGreaterThan(200); expect(g).toBeLessThan(60); expect(b).toBeLessThan(60);
  });
});
