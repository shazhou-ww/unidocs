import { describe, it, expect } from "vitest";
import {
  countLayers, decodedBytes, cacheBytesFor, rectsOverlap,
  collectDegradations, layerKind, flattenTree,
  type LocalLayer, type SizedLayer,
} from "../src/doc-model.js";

const leaf = (id: string, over: Partial<LocalLayer> = {}): LocalLayer => ({
  id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, ...over,
});

describe("countLayers", () => {
  it("counts nested children", () => {
    const layers = [leaf("a"), leaf("g", { type: "group", children: [leaf("b"), leaf("c")] })];
    expect(countLayers(layers)).toBe(4);
  });
});

describe("decodedBytes / cacheBytesFor", () => {
  it("sums layer and mask pixels across groups", () => {
    const layers: SizedLayer[] = [
      { ...leaf("a"), pixels: { width: 10, height: 10 } },
      { ...leaf("g"), type: "group", children: [
        { ...leaf("b"), pixels: { width: 5, height: 4 }, mask: { pixels: { width: 2, height: 2 } } },
      ] },
    ];
    expect(decodedBytes(layers)).toBe((100 + 20 + 4) * 4);
  });

  it("floors small documents at 128 MiB", () => {
    expect(cacheBytesFor([])).toBe(128 * 1024 * 1024);
  });

  it("caps huge documents at 1 GiB", () => {
    const huge: SizedLayer[] = [{ ...leaf("h"), pixels: { width: 20000, height: 20000 } }];
    expect(cacheBytesFor(huge)).toBe(1024 * 1024 * 1024);
  });
});

describe("rectsOverlap", () => {
  it("is true for overlapping rects and false for touching ones", () => {
    expect(rectsOverlap([0, 0, 10, 10], [5, 5, 15, 15])).toBe(true);
    expect(rectsOverlap([0, 0, 10, 10], [10, 10, 20, 20])).toBe(false);
  });
});

describe("layerKind", () => {
  it("maps every PSD layer type to a badge", () => {
    expect(layerKind("text")).toEqual({ label: "T", token: "text" });
    expect(layerKind("fill")).toEqual({ label: "SHP", token: "shp" });
    expect(layerKind("group")).toEqual({ label: "GRP", token: "grp" });
    expect(layerKind("raster")).toEqual({ label: "IMG", token: "img" });
    expect(layerKind("smartObject")).toEqual({ label: "SO", token: "img" });
    expect(layerKind("adjustment")).toEqual({ label: "ADJ", token: "adj" });
  });
});

describe("collectDegradations", () => {
  it("walks the tree and tags each row with its layer", () => {
    const layers = [
      leaf("t", { name: "headline", degraded: [{ reason: "文字层已栅格化", detail: "d" }] }),
      leaf("g", { type: "group", children: [
        leaf("s", { name: "hero", degraded: [{ reason: "智能对象已展平" }] }),
      ] }),
      leaf("plain"),
    ];
    expect(collectDegradations(layers)).toEqual([
      { layerId: "t", layerName: "headline", reason: "文字层已栅格化", detail: "d" },
      { layerId: "s", layerName: "hero", reason: "智能对象已展平" },
    ]);
  });
});

describe("flattenTree", () => {
  it("emits children only for expanded groups, in top-down order with depth", () => {
    const layers = [
      leaf("g", { type: "group", children: [leaf("b"), leaf("c")] }),
      leaf("a"),
    ];
    expect(flattenTree(layers, new Set()).map((r) => [r.layer.id, r.depth, r.hasChildren]))
      .toEqual([["g", 0, true], ["a", 0, false]]);
    expect(flattenTree(layers, new Set(["g"])).map((r) => [r.layer.id, r.depth]))
      .toEqual([["g", 0], ["b", 1], ["c", 1], ["a", 0]]);
  });
});
