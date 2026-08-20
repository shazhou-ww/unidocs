import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer, Mask } from "../src/model/types.js";
import { adjust } from "../src/ops/adjust-ops.js";
import { maskEdit } from "../src/ops/mask-ops.js";
import { findLayer } from "../src/model/tree.js";

const base = { bounds: [0,0,1,1] as [number,number,number,number], opacity: 1, blendMode: "normal" as const, visible: true, locked: false, clipping: false };
const doc = (): PsdDoc => ({
  canvas: { width: 4, height: 4, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [
    { id: "r", type: "raster", name: "r", ...base },
    { id: "adj", type: "adjustment", name: "adj", adjustType: "brit", params: { brightness: 0 }, ...base },
  ],
});
const mask = (): Mask => ({ pixels: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, bounds: [0,0,1,1], defaultColor: 0, inverted: false });

describe("adjust + mask ops", () => {
  it("adjust merges params on adjustment layer", () => {
    const d = doc();
    adjust(d, { layerId: "adj", params: { brightness: 0.2, contrast: 0.1 } });
    expect(findLayer(d.layers, "adj")!.params).toEqual({ brightness: 0.2, contrast: 0.1 });
  });

  it("adjust rejects non-adjustment layer", () => {
    const d = doc();
    expect(() => adjust(d, { layerId: "r", params: {} })).toThrow(/adjustment/);
  });

  it("mask_edit sets then removes a mask", () => {
    const d = doc();
    maskEdit(d, { layerId: "r", mask: mask() });
    expect(findLayer(d.layers, "r")!.mask).not.toBeNull();
    maskEdit(d, { layerId: "r", mask: null });
    expect(findLayer(d.layers, "r")!.mask).toBeNull();
  });
});
