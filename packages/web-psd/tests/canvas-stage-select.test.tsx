import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { App } from "../src/ui/app.js";
import { getState, setState } from "../src/ui/store.js";
import { rectRegion } from "../src/ui/region.js";
import type { LocalLayer } from "../src/doc-model.js";

const { dispatch, hitTest } = vi.hoisted(() => ({ dispatch: vi.fn(), hitTest: vi.fn() }));
// `vi.mock` replaces the WHOLE module, so every export any rendered component
// imports has to be here — the Escape tests below render <App />, and
// `top-bar.tsx:3` imports `exportUrl` and `openFile`. Leaving them out gives
// an undefined-is-not-a-function throw from a component that has nothing to
// do with selection.
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

// See canvas-stage-drag.test.tsx: jsdom 25 has no PointerEvent constructor, so
// a MouseEvent named "pointer*" is what carries clientX/Y to React's handlers.
const pointer = (type: string, clientX: number, clientY: number, init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true, ...init });

const leaf = (id: string, bounds: [number, number, number, number], over: Partial<LocalLayer> = {}): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds, ...over });

const group = (id: string, children: LocalLayer[], over: Partial<LocalLayer> = {}): LocalLayer =>
  ({ id, type: "group", name: id, opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 0, 0], children, ...over });

/** Lets the awaited hit settle before assertions: the handler chains two
 *  microtasks (the hitTest promise, then `.then`). */
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

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
        bounds: [0, 0, 0, 0], children: [leaf("a", [10, 10, 30, 30])] },
      leaf("b", [60, 60, 70, 70]),
    ] },
  });
});

describe("click semantics", () => {
  it("selects the outermost group on a plain click", async () => {
    hitTest.mockResolvedValue([{ layerId: "a", path: ["g", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent(stageOf(container), pointer("pointerdown", 15, 15));
    await flush();
    expect(getState().selection).toEqual(["g"]);
  });

  it("selects the leaf on ⌘-click", async () => {
    hitTest.mockResolvedValue([{ layerId: "a", path: ["g", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent(stageOf(container), pointer("pointerdown", 15, 15, { metaKey: true }));
    await flush();
    expect(getState().selection).toEqual(["a"]);
  });

  it("adds on shift-click", async () => {
    setState({ selection: ["b"] });
    hitTest.mockResolvedValue([{ layerId: "a", path: ["g", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent(stageOf(container), pointer("pointerdown", 15, 15, { shiftKey: true }));
    await flush();
    expect(getState().selection).toEqual(["b", "g"]);
  });

  // A root group covering the whole canvas is common in PSDs; selecting it
  // gives a box flush with the canvas edge and drags the entire document.
  it("descends past a group that covers most of the canvas", async () => {
    setState({ doc: { canvas: { width: 100, height: 100 }, layers: [
      { id: "root", type: "group", name: "root", opacity: 1, blendMode: "normal", visible: true,
        bounds: [0, 0, 0, 0], children: [leaf("bg", [0, 0, 100, 100]), leaf("a", [10, 10, 30, 30])] },
    ] } });
    hitTest.mockResolvedValue([{ layerId: "a", path: ["root", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent(stageOf(container), pointer("pointerdown", 15, 15));
    await flush();
    expect(getState().selection).toEqual(["a"]);
  });

  it("descends one level on double click", async () => {
    setState({ selection: ["g"] });
    hitTest.mockResolvedValue([{ layerId: "a", path: ["g", "a"] }]);
    const { container } = render(<CanvasStage />);
    fireEvent.doubleClick(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    expect(getState().selection).toEqual(["a"]);
  });

  // A real double click fires two full pointerdown/pointerup pairs BEFORE the
  // `dblclick` event: the second pointerdown starts its own async settle
  // (`p2`), independent of `onDoubleClick`'s own hit test. Today's request
  // queue happens to resolve them in FIFO order so the descent wins anyway —
  // but nothing enforces that ordering, so this pins the outcome directly by
  // resolving `p2`'s hit test AFTER the double click's, and asserting the
  // stale single-click settle is superseded rather than overwriting the
  // descent it raced.
  it("keeps the descent even when the raced single-click settle resolves later", async () => {
    setState({ selection: [], doc: { canvas: { width: 100, height: 100 }, layers: [
      group("root", [leaf("bg", [0, 0, 100, 100]), group("mid", [leaf("deep", [10, 10, 30, 30])])]),
    ] } });
    const hit = { layerId: "deep", path: ["root", "mid", "deep"] };
    const resolvers: Array<(hits: typeof hit[]) => void> = [];
    hitTest.mockImplementation(() => new Promise<(typeof hit)[]>((resolve) => { resolvers.push(resolve); }));

    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    fireEvent(stage, pointer("pointerdown", 15, 15));   // p1 — resolvers[0]
    fireEvent(stage, pointer("pointerup", 15, 15));
    fireEvent(stage, pointer("pointerdown", 15, 15));   // p2 — resolvers[1]
    fireEvent(stage, pointer("pointerup", 15, 15));
    fireEvent.doubleClick(stage, { clientX: 15, clientY: 15 }); // onDoubleClick — resolvers[2]

    // The double click's own hit test resolves first: "root" covers the whole
    // canvas, so `clickTarget` would skip it on a plain click, but nothing is
    // selected yet, so `descendPath` starts at the outermost level.
    resolvers[2]([hit]);
    await flush();
    expect(getState().selection).toEqual(["root"]);

    // The second pointerdown's stale settle lands after. Unsuperseded, it
    // would call `clickTarget` (which descends past "root") and overwrite the
    // selection with "mid".
    resolvers[1]([hit]);
    await flush();
    expect(getState().selection).toEqual(["root"]);

    // The first pointerdown's settle, later still, must be inert too.
    resolvers[0]([hit]);
    await flush();
    expect(getState().selection).toEqual(["root"]);
  });

  // No op in the engine checks `locked` — it is only a writable property — so
  // if the front end does not refuse the drag, nothing will.
  it("selects a locked layer but dispatches no op when dragging it", async () => {
    setState({ doc: { canvas: { width: 100, height: 100 }, layers: [leaf("p", [0, 0, 50, 50], { locked: true })] } });
    hitTest.mockResolvedValue([{ layerId: "p", path: ["p"] }]);
    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    fireEvent(stage, pointer("pointerdown", 15, 15));
    fireEvent(stage, pointer("pointermove", 40, 15));
    await flush();
    expect(getState().selection).toEqual(["p"]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("Escape", () => {
  it("clears both axes, which is the one gesture that does", () => {
    setState({ selection: ["b"], region: rectRegion([0, 0, 10, 10]) });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(getState().selection).toEqual([]);
    expect(getState().region).toBeNull();
  });

  it("is ignored while typing — Escape in the composer is not a deselect", () => {
    setState({ selection: ["b"] });
    const { container } = render(<App />);
    const textarea = container.querySelector("textarea")!;
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(getState().selection).toEqual(["b"]);
  });
});
