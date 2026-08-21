import { describe, it, expect } from "vitest";
import type { Layer } from "../src/model/types.js";
import { layerInfluenceBounds } from "../src/render/region.js";

const CANVAS = { width: 100, height: 100 };
const base = (over: Partial<Layer>): Layer => ({
  id: "l", type: "raster", name: "l", bounds: [40, 40, 60, 60],
  opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
  ...over,
});

describe("layerInfluenceBounds", () => {
  it("plain raster: just its bounds", () => {
    expect(layerInfluenceBounds(base({}), CANVAS)).toEqual([40, 40, 60, 60]);
  });

  it("outside stroke expands by size on all sides", () => {
    const l = base({ stroke: { color: { r: 0, g: 0, b: 0 }, opacity: 1, size: 5, position: "outside", blendMode: "normal" } });
    expect(layerInfluenceBounds(l, CANVAS)).toEqual([35, 35, 65, 65]);
  });

  it("drop shadow unions the offset+blurred copy", () => {
    // angle 0 → dx = -distance, dy = 0; expand by size+choke.
    const l = base({ dropShadow: { color: { r: 0, g: 0, b: 0 }, opacity: 1, blendMode: "normal", angle: 0, distance: 10, size: 4, choke: 0 } });
    // shape [40,40,60,60] ∪ shifted-by-(-10,0) then grown by 4:
    // shifted bounds = [40, 30, 60, 50]; grown = [36, 26, 64, 54]; union with shape = [36,26,64,60]
    expect(layerInfluenceBounds(l, CANVAS)).toEqual([36, 26, 64, 60]);
  });

  it("clamps to the canvas", () => {
    const l = base({ bounds: [-5, -5, 10, 10], stroke: { color: { r: 0, g: 0, b: 0 }, opacity: 1, size: 3, position: "outside", blendMode: "normal" } });
    const [t, le] = layerInfluenceBounds(l, CANVAS);
    expect(t).toBe(0); expect(le).toBe(0);
  });

  it("adjustment influences the whole canvas (or its mask bounds)", () => {
    const l = base({ type: "adjustment", adjustType: "brit" });
    expect(layerInfluenceBounds(l, CANVAS)).toEqual([0, 0, 100, 100]);
  });

  const mask = (defaultColor: number, inverted: boolean) => ({
    pixels: { width: 0, height: 0, data: new Uint8ClampedArray(0) },
    bounds: [40, 40, 60, 60] as const,
    defaultColor,
    inverted,
  });

  it("adjustment + mask with defaultColor=0, inverted=false restricts to mask bounds", () => {
    const l = base({ type: "adjustment", adjustType: "brit", mask: mask(0, false) });
    expect(layerInfluenceBounds(l, CANVAS)).toEqual([40, 40, 60, 60]);
  });

  it("adjustment + mask with defaultColor=255, inverted=false covers full canvas", () => {
    const l = base({ type: "adjustment", adjustType: "brit", mask: mask(255, false) });
    expect(layerInfluenceBounds(l, CANVAS)).toEqual([0, 0, 100, 100]);
  });

  it("adjustment + mask with defaultColor=0, inverted=true covers full canvas", () => {
    const l = base({ type: "adjustment", adjustType: "brit", mask: mask(0, true) });
    expect(layerInfluenceBounds(l, CANVAS)).toEqual([0, 0, 100, 100]);
  });
});
