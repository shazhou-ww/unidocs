import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { generativeFill } from "../src/ops/generative-ops.js";
import { findLayer } from "../src/model/tree.js";

const doc = (): PsdDoc => ({ canvas: { width: 8, height: 8, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [] });
const result = (id: string): Layer => ({ id, type: "raster", name: id, bounds: [0,0,8,8], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: { width: 8, height: 8, data: new Uint8ClampedArray(8*8*4) } });

describe("generative_fill", () => {
  it("inserts pre-generated layer + provenance", () => {
    const d = doc();
    generativeFill(d, { layer: result("g1"), parentId: null, provenance: { model: "sdxl@1", seed: 42, prompt: "remove car" } });
    const g = findLayer(d.layers, "g1")!;
    expect(g.provenance).toEqual({ model: "sdxl@1", seed: 42, prompt: "remove car" });
  });

  it("rejects a layer with no pixels (must be pre-resolved)", () => {
    const d = doc();
    const noPix = { ...result("g2"), pixels: undefined } as Layer;
    expect(() => generativeFill(d, { layer: noPix, parentId: null, provenance: { model: "m", seed: 1, prompt: "p" } })).toThrow(/pixels/);
  });
});
