import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { getState, setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const { dispatch, hitTest } = vi.hoisted(() => ({ dispatch: vi.fn(), hitTest: vi.fn() }));
// `vi.mock` replaces the WHOLE module, so every export any rendered component
// imports has to be here — see canvas-stage-select.test.tsx.
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    hitTest,
  }),
  dispatch,
  exportUrl: () => null,
  openFile: vi.fn(),
}));

const leaf = (id: string, bounds: [number, number, number, number], over: Partial<LocalLayer> = {}): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds, ...over });

/** Lets the awaited hit settle before assertions: the handler chains two
 *  microtasks (the hitTest promise, then `.then`). Unlike
 *  canvas-stage-select.test.tsx's version, this one has to be wrapped in
 *  `act()`: the menu's `useState` update happens outside any React event
 *  handler (inside the resolved-promise callback), so React schedules the
 *  re-render through its normal scheduler rather than flushing synchronously
 *  — `act()` drains that queue instead of requiring a real timer tick. The
 *  other tests in this plan never needed this because they read `getState()`
 *  directly rather than asserting on rendered DOM. */
const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

const stageOf = (container: HTMLElement): Element => container.querySelector("div.stage")!;

beforeEach(() => {
  dispatch.mockClear();
  hitTest.mockReset();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({
    tool: "move", region: null, selection: [], pickedColor: null, expanded: new Set(),
    doc: { canvas: { width: 100, height: 100 }, layers: [
      { id: "g", type: "group", name: "g", opacity: 1, blendMode: "normal", visible: true,
        bounds: [0, 0, 0, 0], children: [leaf("top", [10, 10, 30, 30])] },
      leaf("bg", [0, 0, 100, 100]),
    ] },
  });
});

describe("HitMenu", () => {
  const stack = [
    { layerId: "top", path: ["g", "top"] },
    { layerId: "bg", path: ["bg"] },
  ];

  // One click landing on several plausible layers is the normal case in a PSD,
  // so the whole stack is offered instead of the code guessing.
  it("lists every candidate under the cursor, topmost first", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    const items = [...container.querySelectorAll(".hit-menu button")].map((b) => b.textContent);
    expect(items).toEqual(["top", "bg"]);
  });

  it("selects the one that is clicked and closes", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    fireEvent.click(container.querySelectorAll(".hit-menu button")[1]);
    expect(getState().selection).toEqual(["bg"]);
    expect(container.querySelector(".hit-menu")).toBeNull();
  });

  it("closes on Escape without changing the selection", async () => {
    setState({ selection: ["b"] });
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".hit-menu")).toBeNull();
    expect(getState().selection).toEqual(["b"]);
  });

  it("renders nothing when the cursor is over empty canvas", async () => {
    hitTest.mockResolvedValue([]);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 90, clientY: 90 });
    await flush();
    expect(container.querySelector(".hit-menu")).toBeNull();
  });
});
