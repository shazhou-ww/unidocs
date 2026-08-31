import { describe, it, expect } from "vitest";
import type { Layer, Pixels } from "@unidocs/doctype-psd/engine";
import { alphaAt, hitInList, layerBoxOf, residentOnly, HIT_ALPHA_THRESHOLD } from "../src/layer-alpha.js";

function px(w: number, h: number, alpha: number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4 + 3] = alpha; }
  return { width: w, height: h, data };
}

const base = {
  type: "raster" as const, opacity: 1, blendMode: "normal" as const,
  visible: true, locked: false, clipping: false,
};

const raster = (id: string, bounds: [number, number, number, number], alpha: number, over: Partial<Layer> = {}): Layer => ({
  ...base, id, name: id, bounds,
  pixels: px(bounds[3] - bounds[1], bounds[2] - bounds[0], alpha),
  ...over,
});

const group = (id: string, children: Layer[], over: Partial<Layer> = {}): Layer =>
  ({ ...base, id, name: id, type: "group", bounds: [0, 0, 0, 0], children, ...over });

const at = (x: number, y: number): Array<[number, number]> => [[x, y]];

describe("alphaAt", () => {
  it("reads the layer's own alpha at a canvas point", () => {
    expect(alphaAt(raster("a", [10, 10, 20, 20], 255), 15, 15, residentOnly, false)).toBeCloseTo(1);
  });

  it("is zero outside the layer's bounds", () => {
    expect(alphaAt(raster("a", [10, 10, 20, 20], 255), 5, 5, residentOnly, false)).toBe(0);
  });

  it("multiplies opacity and fillOpacity, but not for a clip base's shape", () => {
    const l = raster("a", [0, 0, 10, 10], 255, { opacity: 0.5, fillOpacity: 0.5 });
    expect(alphaAt(l, 5, 5, residentOnly, false)).toBeCloseTo(0.25);
    expect(alphaAt(l, 5, 5, residentOnly, true)).toBeCloseTo(1);
  });

  it("multiplies the layer mask", () => {
    const l = raster("a", [0, 0, 10, 10], 255, {
      mask: { pixels: px(10, 10, 0), bounds: [0, 0, 10, 10], defaultColor: 0, inverted: false },
    });
    // The mask's channel 0 is 0 everywhere, so nothing shows through.
    expect(alphaAt(l, 5, 5, residentOnly, false)).toBe(0);
  });

  it("takes a group's alpha from its most opaque visible child", () => {
    const g = group("g", [raster("hidden", [0, 0, 10, 10], 255, { visible: false }), raster("b", [0, 0, 10, 10], 128)]);
    expect(alphaAt(g, 5, 5, residentOnly, false)).toBeCloseTo(128 / 255, 2);
  });

  it("is zero for an adjustment layer, which acts on the whole backdrop and can never be pointed at", () => {
    expect(alphaAt({ ...base, id: "adj", name: "adj", type: "adjustment", bounds: [0, 0, 10, 10] }, 5, 5, residentOnly, false)).toBe(0);
  });
});

describe("hitInList", () => {
  it("returns candidates topmost first — layers[0] is the BOTTOM of the document", () => {
    const layers = [raster("bottom", [0, 0, 10, 10], 255), raster("top", [0, 0, 10, 10], 255)];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["top", "bottom"]);
  });

  it("skips a transparent layer and finds the opaque one beneath it", () => {
    const layers = [raster("solid", [0, 0, 10, 10], 255), raster("clear", [0, 0, 10, 10], 0)];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["solid"]);
  });

  it("ignores an almost-transparent glow edge, which is what the threshold is for", () => {
    const layers = [raster("glow", [0, 0, 10, 10], 4)];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly)).toEqual([]);
  });

  it("reports a leaf inside a group with the full ancestor path", () => {
    const layers = [group("outer", [group("inner", [raster("deep", [0, 0, 10, 10], 255)])])];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly))
      .toEqual([{ layerId: "deep", path: ["outer", "inner", "deep"] }]);
  });

  it("still hits a locked layer — Photoshop selects it, it just cannot be edited", () => {
    const layers = [raster("locked", [0, 0, 10, 10], 255, { locked: true })];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["locked"]);
  });

  // A clipping layer is confined ON SCREEN to the alpha of the base below it,
  // but its OWN alpha stays non-zero where it is being clipped away — testing
  // it alone selects it in places the eye cannot see it.
  it("confines a clipping layer to the alpha of the base beneath it", () => {
    const layers = [
      raster("base", [0, 0, 10, 10], 255),
      raster("clip", [0, 0, 20, 20], 255, { clipping: true }),
    ];
    expect(hitInList(layers, at(5, 5), HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["clip", "base"]);
    // (15,15) is inside `clip`'s own bounds but outside the base's, so the
    // clipped layer paints nothing there and must not be hittable.
    expect(hitInList(layers, at(15, 15), HIT_ALPHA_THRESHOLD, residentOnly)).toEqual([]);
  });

  it("accepts several sample points and takes the most opaque, which is the click tolerance", () => {
    const layers = [raster("thin", [0, 0, 1, 10], 255)];
    expect(hitInList(layers, [[5, 3]], HIT_ALPHA_THRESHOLD, residentOnly)).toEqual([]);
    expect(hitInList(layers, [[5, 3], [5, 0]], HIT_ALPHA_THRESHOLD, residentOnly).map((h) => h.layerId))
      .toEqual(["thin"]);
  });
});

describe("layerBoxOf", () => {
  it("unions a group's visible children, since a PSD group reports 0,0,0,0", () => {
    expect(layerBoxOf(group("g", [raster("a", [10, 10, 20, 20], 255), raster("b", [40, 5, 50, 30], 255)])))
      .toEqual([10, 5, 50, 30]);
  });
});
