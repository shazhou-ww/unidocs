import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { setState, getState } from "../src/ui/store.js";
import { wheelZoomFactor } from "../src/ui/zoom.js";

const stage = { clientWidth: 1000, clientHeight: 800, scrollLeft: 0, scrollTop: 0,
                getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }) };
const requestVisibleTiles = vi.fn();

vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  dispatch: vi.fn(),
  getController: () => ({
    requestVisibleTiles,
    stage,
    canvasRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    toCanvas: (x: number, y: number) => ({ x: x / getState().zoom, y: y / getState().zoom }),
    toScreen: (x: number, y: number) => ({ x: x * getState().zoom, y: y * getState().zoom }),
    pickColor: () => null,
  }),
}));

// rAF is driven by hand so the coalescing window is observable: nothing should
// happen until the frame runs, and then exactly once.
let frames: Array<() => void> = [];
beforeEach(() => {
  frames = [];
  requestVisibleTiles.mockClear();
  stage.scrollLeft = 0;
  stage.scrollTop = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  setState({ zoom: 1, tool: "marquee", region: null, selection: [],
             doc: { canvas: { width: 2000, height: 1000 }, layers: [] } as never });
});
afterEach(() => { vi.unstubAllGlobals(); });

const runFrame = (): void => { const fs = frames; frames = []; for (const f of fs) f(); };

describe("ctrl/⌘ + wheel zoom", () => {
  it("ignores a plain wheel, which is the pan gesture", () => {
    const { container } = render(<CanvasStage />);
    fireEvent.wheel(container.querySelector(".stage")!, { deltaY: -100 });
    runFrame();
    expect(getState().zoom).toBe(1);
  });

  it("zooms in on a negative delta and out on a positive one", () => {
    const { container } = render(<CanvasStage />);
    const el = container.querySelector(".stage")!;
    fireEvent.wheel(el, { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 200 });
    runFrame();
    expect(getState().zoom).toBeGreaterThan(1);

    setState({ zoom: 1 });
    fireEvent.wheel(el, { deltaY: 100, ctrlKey: true, clientX: 300, clientY: 200 });
    runFrame();
    expect(getState().zoom).toBeLessThan(1);
  });

  it("coalesces a burst into ONE zoom per frame, losing no scroll distance", () => {
    const { container } = render(<CanvasStage />);
    const el = container.querySelector(".stage")!;
    // A trackpad pinch emits far faster than the screen refreshes.
    for (let i = 0; i < 5; i++) {
      fireEvent.wheel(el, { deltaY: -20, ctrlKey: true, clientX: 300, clientY: 200 });
    }
    // Nothing applied yet: the frame has not run.
    expect(getState().zoom).toBe(1);

    const before = requestVisibleTiles.mock.calls.length;
    runFrame();
    // One application, and the deltas summed rather than the last one winning:
    // 5 x -20 is one notch's worth (-100), not -20.
    expect(getState().zoom).toBeCloseTo(wheelZoomFactor(-100), 8);
    expect(getState().zoom).not.toBeCloseTo(wheelZoomFactor(-20), 4);
    // And one tile refetch for the burst, not five.
    expect(requestVisibleTiles.mock.calls.length - before).toBe(1);
  });

  it("keeps zooming across successive frames", () => {
    const { container } = render(<CanvasStage />);
    const el = container.querySelector(".stage")!;
    fireEvent.wheel(el, { deltaY: -50, ctrlKey: true, clientX: 300, clientY: 200 });
    runFrame();
    const afterFirst = getState().zoom;
    fireEvent.wheel(el, { deltaY: -50, ctrlKey: true, clientX: 300, clientY: 200 });
    runFrame();
    expect(getState().zoom).toBeGreaterThan(afterFirst);
  });

  it("anchors on the cursor, not the stage centre", () => {
    const { container } = render(<CanvasStage />);
    const el = container.querySelector(".stage")!;
    fireEvent.wheel(el, { deltaY: -240, ctrlKey: true, clientX: 300, clientY: 200 });
    runFrame();
    const z = getState().zoom;
    expect(z).toBeGreaterThan(1);
    // The document point under the cursor was at 300/1 = 300; after the zoom
    // it sits at 300*z, so the stage must scroll by the difference to put it
    // back under the cursor. Derived from the zoom actually reached rather
    // than a hard-coded factor, so the assertion survives a rate change.
    expect(stage.scrollLeft).toBeCloseTo(300 * (z - 1), 4);
    expect(stage.scrollTop).toBeCloseTo(200 * (z - 1), 4);
  });
});
