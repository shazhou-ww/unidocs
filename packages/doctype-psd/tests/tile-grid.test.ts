import { describe, it, expect } from "vitest";
import { allTiles, tilesForRect, tileKey } from "../src/render/tile-grid.js";

const C = { width: 500, height: 300 }; // with tileSize 256 → cols=2 (0..256,256..500), rows=2 (0..256,256..300)

describe("tileKey", () => {
  it("formats tx,ty", () => { expect(tileKey(1, 2)).toBe("1,2"); });
});

describe("allTiles", () => {
  it("covers the whole canvas exactly, clipped to bounds", () => {
    const t = allTiles(C, 256);
    expect(t.length).toBe(4);
    expect(t.map((x) => x.region)).toEqual([
      [0, 0, 256, 256], [0, 256, 256, 500],
      [256, 0, 300, 256], [256, 256, 300, 500],
    ]);
  });
});

describe("tilesForRect", () => {
  it("returns only tiles intersecting the rect, regions clipped to canvas", () => {
    const t = tilesForRect(C, 256, [10, 10, 20, 20]); // top-left tile only
    expect(t.map((x) => x.region)).toEqual([[0, 0, 256, 256]]);
  });
  it("spans multiple tiles", () => {
    const t = tilesForRect(C, 256, [250, 250, 260, 260]); // straddles all 4
    expect(t.length).toBe(4);
  });
  it("empty for degenerate / off-canvas rect", () => {
    expect(tilesForRect(C, 256, [10, 10, 10, 10])).toEqual([]); // zero-area
    expect(tilesForRect(C, 256, [400, 400, 300, 300])).toEqual([]); // inverted
    expect(tilesForRect(C, 256, [500, 0, 600, 100])).toEqual([]); // below canvas
  });
});
