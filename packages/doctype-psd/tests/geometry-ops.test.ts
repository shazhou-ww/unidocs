import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { crop, transform } from "../src/ops/geometry-ops.js";
import { findLayer } from "../src/model/tree.js";

const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w*h*4) });
const layer = (id: string, bounds: [number,number,number,number]): Layer => ({ id, type: "raster", name: id, bounds, opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: px(bounds[3]-bounds[1], bounds[2]-bounds[0]) });
const doc = (): PsdDoc => ({ canvas: { width: 100, height: 100, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [layer("a", [10,10,30,30])] });

describe("geometry ops", () => {
  it("crop resizes canvas and shifts bounds", () => {
    const d = doc();
    crop(d, { rect: [5, 5, 55, 55] }); // top,left,bottom,right
    expect([d.canvas.width, d.canvas.height]).toEqual([50, 50]);
    expect(findLayer(d.layers, "a")!.bounds).toEqual([5, 5, 25, 25]);
  });

  it("transform translate shifts bounds only", () => {
    const d = doc();
    transform(d, { layerId: "a", op: { translate: [4, 3] } });
    expect(findLayer(d.layers, "a")!.bounds).toEqual([13, 14, 33, 34]); // top+3,left+4,bottom+3,right+4
  });

  it("transform rejects scale/rotate in MVP", () => {
    const d = doc();
    expect(() => transform(d, { layerId: "a", op: { scale: [2, 2] } as any })).toThrow(/not supported/);
  });
});
