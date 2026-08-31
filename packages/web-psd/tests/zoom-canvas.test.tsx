import { describe, it, expect, vi, beforeEach } from "vitest";
import { canvasBoxStyle } from "../src/ui/panels/canvas-stage.js";
import { setState, getState } from "../src/ui/store.js";

/**
 * The stage stands in for the scrolling container: `scrollLeft`/`scrollTop`
 * are plain writable numbers so the anchor compensation's effect is readable.
 * `toCanvas`/`toScreen` model the real measured mapping — document pixels
 * times the CURRENT zoom — by reading the zoom back out of the store, which
 * is exactly what measuring the laid-out box amounts to.
 */
const stage = { clientWidth: 1000, clientHeight: 800, scrollLeft: 0, scrollTop: 0,
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }) };
let canvasLeft = 0;
let canvasTop = 0;

const requestVisibleTiles = vi.fn();
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  dispatch: vi.fn(),
  getController: () => ({
    requestVisibleTiles,
    stage,
    canvasRect: () => ({ left: canvasLeft, top: canvasTop, width: 0, height: 0, right: 0, bottom: 0 }),
    toCanvas: (cx: number, cy: number) => ({ x: (cx - canvasLeft) / getState().zoom, y: (cy - canvasTop) / getState().zoom }),
    toScreen: (dx: number, dy: number) => ({ x: dx * getState().zoom, y: dy * getState().zoom }),
  }),
  openFile: vi.fn(),
  exportUrl: () => null,
}));

const { zoomTo } = await import("../src/ui/zoom-controller.js");

beforeEach(() => {
  requestVisibleTiles.mockClear();
  stage.scrollLeft = 0;
  stage.scrollTop = 0;
  canvasLeft = 0;
  canvasTop = 0;
  setState({ zoom: 1, doc: { canvas: { width: 2000, height: 1000 }, layers: [] } as never });
});

describe("canvasBoxStyle", () => {
  it("scales the CSS box by the zoom while the bitmap stays the document", () => {
    expect(canvasBoxStyle({ width: 800, height: 600 }, 2)).toEqual({
      width: 1600, height: 1200, imageRendering: "pixelated",
    });
  });

  it("rounds to whole CSS pixels", () => {
    const style = canvasBoxStyle({ width: 801, height: 601 }, 0.333);
    expect(style?.width).toBe(267);
    expect(style?.height).toBe(200);
  });

  it("smooths when minifying and preserves pixels when magnifying", () => {
    // Nearest-neighbour when shrinking drops whole rows; smoothing when
    // magnifying defeats the point of magnifying.
    expect(canvasBoxStyle({ width: 100, height: 100 }, 0.5)?.imageRendering).toBe("auto");
    expect(canvasBoxStyle({ width: 100, height: 100 }, 1)?.imageRendering).toBe("pixelated");
    expect(canvasBoxStyle({ width: 100, height: 100 }, 4)?.imageRendering).toBe("pixelated");
  });

  it("hides the canvas before a document is open", () => {
    // Left visible it shows at its intrinsic 300x150 with `.view`'s white fill
    // and shadow — a blank card mid-stage that reads as a failed load.
    expect(canvasBoxStyle(null, 1)).toEqual({ display: "none" });
    expect(canvasBoxStyle({ width: 0, height: 0 }, 1)).toEqual({ display: "none" });
  });
});

describe("zoom anchoring", () => {
  it("holds the document point under the cursor in place when zooming in", () => {
    // Cursor at client x=300, canvas at x=0, zoom 1 -> document x=300.
    // After zooming to 2, that point sits at screen x=600, i.e. 300px right
    // of the cursor, so the stage must scroll right by 300 to put it back.
    zoomTo(2, { clientX: 300, clientY: 200 });
    expect(getState().zoom).toBe(2);
    expect(stage.scrollLeft).toBe(300);
    expect(stage.scrollTop).toBe(200);
  });

  it("holds it in place when zooming out too", () => {
    setState({ zoom: 2 });
    // document x = 300/2 = 150; at zoom 1 it lands at 150, i.e. 150 LEFT of
    // the cursor, so scroll back by -150.
    zoomTo(1, { clientX: 300, clientY: 200 });
    expect(stage.scrollLeft).toBe(-150);
  });

  it("accounts for a canvas that is not at the stage origin", () => {
    canvasLeft = 40;
    // document x = (300-40)/1 = 260; after zoom 2 it is at 40 + 520 = 560,
    // which is 260 right of the cursor.
    zoomTo(2, { clientX: 300, clientY: 200 });
    expect(stage.scrollLeft).toBe(260);
  });

  it("anchors on the stage centre when no cursor is given", () => {
    // Centre of a 1000x800 stage is (500,400) -> document (500,400);
    // at zoom 2 that is (1000,800), i.e. 500/400 past the centre.
    zoomTo(2);
    expect(stage.scrollLeft).toBe(500);
    expect(stage.scrollTop).toBe(400);
  });

  it("does nothing when the zoom is unchanged, rather than scrolling to no purpose", () => {
    zoomTo(1, { clientX: 300, clientY: 200 });
    expect(stage.scrollLeft).toBe(0);
  });

  it("clamps out-of-range targets before anchoring on them", () => {
    zoomTo(99, { clientX: 300, clientY: 200 });
    expect(getState().zoom).toBe(4);
  });
});

describe("refetching tiles after the box changes", () => {
  it("refetches once the new canvas size is committed, not before", async () => {
    // The bug this pins: cold start requests the first tiles at 1:1, THEN
    // fits the document to the stage. A refetch issued from the zoom call
    // site would measure the canvas as it was before the resize and ask for
    // exactly the tiles it already had, leaving the newly-exposed area of a
    // large document blank until an unrelated scroll or resize.
    const { CanvasStage } = await import("../src/ui/panels/canvas-stage.js");
    const { render } = await import("@testing-library/react");
    const { act } = await import("@testing-library/react");

    render(<CanvasStage />);
    requestVisibleTiles.mockClear();

    act(() => { setState({ zoom: 0.25 }); });
    expect(requestVisibleTiles).toHaveBeenCalledTimes(1);

    // A document resize (e.g. an agent crop) exposes a different slice too.
    act(() => { setState({ doc: { canvas: { width: 800, height: 400 }, layers: [] } as never }); });
    expect(requestVisibleTiles).toHaveBeenCalledTimes(2);

    // An unrelated store change must NOT trigger a refetch — the box did not move.
    act(() => { setState({ tool: "eyedrop" }); });
    expect(requestVisibleTiles).toHaveBeenCalledTimes(2);
  });
});
