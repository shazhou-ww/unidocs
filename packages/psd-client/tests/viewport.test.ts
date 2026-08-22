import { describe, it, expect } from "vitest";
import { screenToCanvas, canvasToScreen, visibleTiles } from "../src/viewport.js";

describe("screenToCanvas / canvasToScreen", () => {
  it("round-trips screen -> canvas -> screen for an arbitrary pan/zoom", () => {
    const view = { pan: { x: 40, y: -20 }, zoom: 2 };
    for (const [sx, sy] of [[0, 0], [100, 50], [37.5, 12]] as const) {
      const c = screenToCanvas(view, sx, sy);
      const back = canvasToScreen(view, c.x, c.y);
      expect(back.x).toBeCloseTo(sx);
      expect(back.y).toBeCloseTo(sy);
    }
  });

  it("round-trips canvas -> screen -> canvas too", () => {
    const view = { pan: { x: 5, y: 5 }, zoom: 0.5 };
    const s = canvasToScreen(view, 200, 300);
    const back = screenToCanvas(view, s.x, s.y);
    expect(back.x).toBeCloseTo(200);
    expect(back.y).toBeCloseTo(300);
  });

  it("is the identity when pan is zero and zoom is 1", () => {
    const view = { pan: { x: 0, y: 0 }, zoom: 1 };
    expect(screenToCanvas(view, 42, 17)).toEqual({ x: 42, y: 17 });
    expect(canvasToScreen(view, 42, 17)).toEqual({ x: 42, y: 17 });
  });

  it("subtracts pan before dividing by zoom for screenToCanvas", () => {
    const view = { pan: { x: 10, y: 20 }, zoom: 2 };
    expect(screenToCanvas(view, 10, 20)).toEqual({ x: 0, y: 0 });
    expect(screenToCanvas(view, 30, 40)).toEqual({ x: 10, y: 10 });
  });
});

describe("visibleTiles", () => {
  it("returns the tiles overlapping the viewport rect at zoom=1, no pan", () => {
    const view = { pan: { x: 0, y: 0 }, zoom: 1 };
    const canvasSize = { width: 256, height: 256 };
    const tiles = visibleTiles(view, canvasSize, 64, { width: 100, height: 100 });
    const keys = tiles.map((t) => `${t.tx},${t.ty}`).sort();
    expect(keys).toEqual(["0,0", "0,1", "1,0", "1,1"]);
  });

  it("shifts the visible tile set when panned", () => {
    const view = { pan: { x: -128, y: 0 }, zoom: 1 };
    const canvasSize = { width: 256, height: 256 };
    const tiles = visibleTiles(view, canvasSize, 64, { width: 64, height: 64 });
    const keys = tiles.map((t) => `${t.tx},${t.ty}`).sort();
    expect(keys).toEqual(["2,0"]);
  });

  it("shrinks the visible canvas rect when zoomed in", () => {
    const view = { pan: { x: 0, y: 0 }, zoom: 2 };
    const canvasSize = { width: 256, height: 256 };
    const tiles = visibleTiles(view, canvasSize, 64, { width: 128, height: 128 });
    const keys = tiles.map((t) => `${t.tx},${t.ty}`).sort();
    expect(keys).toEqual(["0,0"]);
  });

  it("clips to the canvas bounds when the viewport hangs off the edge", () => {
    const view = { pan: { x: -200, y: -200 }, zoom: 1 };
    const canvasSize = { width: 256, height: 256 };
    const tiles = visibleTiles(view, canvasSize, 64, { width: 300, height: 300 });
    const keys = tiles.map((t) => `${t.tx},${t.ty}`).sort();
    // viewport covers canvas [200,200]-[500,500], clipped to [200,200]-[256,256] -> tile (3,3)
    expect(keys).toEqual(["3,3"]);
  });
});
