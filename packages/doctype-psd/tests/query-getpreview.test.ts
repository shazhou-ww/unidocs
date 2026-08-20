import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { runQuery } from "../src/queries.js";

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4]=r; d[i*4+1]=g; d[i*4+2]=b; d[i*4+3]=a; }
  return d;
}
const layer: Layer = { id: "a", type: "raster", name: "a", bounds: [0, 0, 4, 6], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: { width: 6, height: 4, data: fill(6, 4, [10, 20, 30, 255]) } };
const doc: PsdDoc = { canvas: { width: 6, height: 4, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [layer] };

describe("getPreview", () => {
  it("whole canvas → a base64 PNG at canvas size", async () => {
    const out = await runQuery({ kind: "getPreview" }, doc) as any;
    expect(out.$image.mediaType).toBe("image/png");
    expect(out.$image.base64.length).toBeGreaterThan(0);
    expect(out.width).toBe(6); expect(out.height).toBe(4);
    expect(out.region).toEqual([0, 0, 4, 6]);
  });

  it("rect → cropped region size", async () => {
    const out = await runQuery({ kind: "getPreview", payload: { rect: [0, 0, 2, 3] } }, doc) as any;
    expect(out.width).toBe(3); expect(out.height).toBe(2);
    expect(out.region).toEqual([0, 0, 2, 3]);
  });

  it("layerId → that layer's bounds size", async () => {
    const out = await runQuery({ kind: "getPreview", payload: { layerId: "a" } }, doc) as any;
    expect(out.width).toBe(6); expect(out.height).toBe(4);
  });

  it("maxSize downscales", async () => {
    const out = await runQuery({ kind: "getPreview", payload: { maxSize: 3 } }, doc) as any;
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(3);
  });
});
