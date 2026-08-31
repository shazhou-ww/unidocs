import { describe, it, expect } from "vitest";
import { rectRegion, describeTarget } from "../src/ui/region.js";

describe("rectRegion", () => {
  it("carries the mask handle slot from day one, empty for a rectangle", () => {
    expect(rectRegion([10, 20, 30, 40])).toEqual({
      bounds: [10, 20, 30, 40], source: "rect", maskId: null,
    });
  });
});

// spec §3.2: an empty axis is a DEFINED DEFAULT, not an error state. All four
// combinations must read as a sentence, or the user gets stuck behind "please
// select a layer first" for the one request that needs no layer at all.
describe("describeTarget", () => {
  const region = rectRegion([0, 0, 10, 10]);
  it("names both axes when both are set", () => {
    expect(describeTarget(["天空"], region)).toBe("天空 · 限定在选区内");
  });
  it("names the layers alone when there is no region", () => {
    expect(describeTarget(["天空", "云"], null)).toBe("天空 + 云");
  });
  it("means every layer inside the region when no layer is selected", () => {
    expect(describeTarget([], region)).toBe("选区内的所有图层");
  });
  it("means the whole document when neither axis is set", () => {
    expect(describeTarget([], null)).toBe("整个文档");
  });
});
