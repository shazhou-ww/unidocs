import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { getState, setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const { dispatch, hitTest } = vi.hoisted(() => ({ dispatch: vi.fn(), hitTest: vi.fn() }));
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    hitTest,
  }),
  dispatch,
}));

// See canvas-stage-drag.test.tsx: jsdom 25 has no PointerEvent constructor, so
// a MouseEvent named "pointer*" is what carries clientX/Y to React's handlers.
const pointer = (type: string, clientX: number, clientY: number): MouseEvent =>
  new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });

const leaf = (id: string): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 100, 100] });

/** Hands back a hit only when `settle()` is called, so the test can drive the
 *  exact interleaving a 20–30ms worker round trip produces. */
function deferredHit(hits: unknown) {
  let settle = (): void => {};
  hitTest.mockImplementation(() => new Promise((resolve) => { settle = () => resolve(hits); }));
  return async (): Promise<void> => { settle(); await Promise.resolve(); await Promise.resolve(); };
}

beforeEach(() => {
  dispatch.mockClear();
  hitTest.mockReset();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({
    tool: "move", region: null, selection: [], pickedColor: null,
    doc: { canvas: { width: 100, height: 100 }, layers: [leaf("a")] },
  });
});

const totalDx = (): number => dispatch.mock.calls
  .map((args) => (args[0].payload.op as { translate: [number, number] }).translate[0])
  .reduce((a: number, b: number) => a + b, 0);

describe("async hit + press-to-drag", () => {
  it("dispatches nothing while the hit test is still in flight", async () => {
    const settle = deferredHit([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 22, 10));
    expect(dispatch).not.toHaveBeenCalled();
    await settle();
    expect(getState().selection).toEqual(["a"]);
  });

  // Using the coordinate the hit came back AT would swallow the movement made
  // during the round trip and the layer would visibly jump behind the cursor.
  it("moves the layer by the FULL finger travel once the hit lands", async () => {
    const settle = deferredHit([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 22, 10));
    await settle();
    expect(totalDx()).toBe(12);
    fireEvent(stage, pointer("pointermove", 30, 10));
    expect(totalDx()).toBe(20);
  });

  it("degrades to a plain click when the pointer is released before the hit lands", async () => {
    const settle = deferredHit([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 22, 10));
    fireEvent(stage, pointer("pointerup", 22, 10));
    await settle();
    expect(getState().selection).toEqual(["a"]);
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent(stage, pointer("pointermove", 40, 10));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("clears the layer axis on a miss and leaves the region alone", async () => {
    // The shared `leaf("a")` fixture covers the whole 100x100 canvas, which
    // would make EVERY point read as "inside the current selection" and take
    // the synchronous drag path (never reaching the async hit test this case
    // means to exercise). Shrinking "a"'s bounds here keeps (90,90) genuinely
    // outside it, so the press has to go through `hitTest` and can actually miss.
    setState({
      doc: { canvas: { width: 100, height: 100 }, layers: [{ ...leaf("a"), bounds: [0, 0, 10, 10] }] },
      selection: ["a"], region: { bounds: [0, 0, 10, 10], source: "rect", maskId: null },
    });
    const settle = deferredHit([]);
    const { container } = render(<CanvasStage />);
    fireEvent(container.querySelector("div.stage")!, pointer("pointerdown", 90, 90));
    await settle();
    expect(getState().selection).toEqual([]);
    expect(getState().region).not.toBeNull();
  });

  it("drags the existing selection with no round trip when the press is inside it", () => {
    setState({ selection: ["a"] });
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 15, 10));
    expect(hitTest).not.toHaveBeenCalled();
    expect(totalDx()).toBe(5);
  });
});
