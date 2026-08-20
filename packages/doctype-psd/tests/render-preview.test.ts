import { describe, it, expect } from "vitest";
import { decode } from "fast-png";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { runQuery } from "../src/queries.js";

const solid = (id: string, w: number, h: number, rgba: number[]): Layer => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i*4]=rgba[0]; data[i*4+1]=rgba[1]; data[i*4+2]=rgba[2]; data[i*4+3]=rgba[3]; }
  return { id, type: "raster", name: id, bounds: [0,0,h,w], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: { width: w, height: h, data } };
};
const doc: PsdDoc = { canvas: { width: 2, height: 2, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [solid("a", 2, 2, [10, 20, 30, 255])] };

function b64ToBytes(b64: string): Uint8Array {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin);
}

describe("getPreview", () => {
  it("returns a base64 PNG of the rendered canvas", async () => {
    const out = await runQuery({ kind: "getPreview" }, doc) as any;
    expect(out.$image.mediaType).toBe("image/png");
    const bytes = b64ToBytes(out.$image.base64);
    // PNG signature
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const img = decode(bytes);
    expect([img.width, img.height]).toEqual([2, 2]);
    expect([...img.data.slice(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([out.width, out.height]).toEqual([2, 2]);
  });
});
