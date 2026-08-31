import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToolStrip } from "../src/ui/panels/tool-strip.js";
import { ContextBar } from "../src/ui/panels/context-bar.js";
import { setState, getState, setRegion } from "../src/ui/store.js";
import { rectRegion, getMask, putMask } from "../src/ui/region.js";

const dispatch = vi.fn();
const pickColor = vi.fn(() => "#f5efe3");
// `loadLayerAsRegion` writes the store itself, so the mock needs a working
// stand-in rather than an empty spy. It references `setRegion`/`putMask`
// directly (not a dynamic `import()`) the same way `dispatch`/`pickColor`
// above are referenced: the factory only runs when `controller.js` is first
// imported, well after these top-level `const`s exist, so the plain
// reference is safe — and unlike a dynamic `import()` (which routes through
// vite-node's module loader and needs far more than the two microtask ticks
// this file's `flush` convention budgets, see canvas-stage-select.test.tsx),
// it resolves within the same tick the click handler runs in.
// A `vi.fn` rather than a bare async function so an individual test can swap
// in a deferred implementation and drive the in-flight window; its default is
// the immediate stand-in every other test here expects.
const loadLayerAsRegion = vi.fn(async (_layerId: string): Promise<void> => {
  setRegion({ bounds: [10, 10, 12, 12], source: "layerAlpha", maskId: putMask(new Uint8ClampedArray([1, 2, 3, 4])) });
});
vi.mock("../src/ui/controller.js", () => ({
  dispatch: (op: unknown) => dispatch(op),
  getController: () => ({ pickColor, toCanvas: (x: number, y: number) => ({ x, y }) }),
  loadLayerAsRegion: (id: string) => loadLayerAsRegion(id),
}));

const oneLayerSelected = (): void => {
  setState({ selection: ["a"], doc: { canvas: { width: 100, height: 100 }, layers: [
    { id: "a", type: "raster", name: "a", opacity: 1, blendMode: "normal", visible: true, bounds: [10, 10, 12, 12] },
  ] } });
};

beforeEach(() => {
  dispatch.mockClear();
  loadLayerAsRegion.mockClear();
  setState({ tool: "move", region: null, selection: [], pickedColor: null });
});

describe("ToolStrip", () => {
  it("switches the active tool", () => {
    render(<ToolStrip />);
    fireEvent.click(screen.getByText("框选"));
    expect(getState().tool).toBe("marquee");
    fireEvent.click(screen.getByText("取色"));
    expect(getState().tool).toBe("eyedrop");
  });
});

describe("ContextBar", () => {
  it("stays quiet with no marquee", () => {
    render(<ContextBar />);
    expect(screen.queryByText("裁到选区")).not.toBeInTheDocument();
  });

  // `describeTarget([], null)` is right for "a document with nothing
  // selected", but the bar renders unconditionally — with no document open at
  // all it claimed the target was the whole document.
  it("does not claim 「整个文档」 on the empty first screen", () => {
    setState({ doc: null });
    render(<ContextBar />);
    expect(screen.queryByText("整个文档")).not.toBeInTheDocument();
    expect(screen.getByText("未选中图层")).toBeInTheDocument();
  });

  it("offers no crop for a zero-area selection, which would commit a 0x0 canvas", () => {
    // One `pointerdown` with no movement is enough to produce this rect, and
    // doctype-psd's `crop` does `doc.canvas.width = right - left` unvalidated.
    setState({ region: rectRegion([30, 30, 30, 30]) });
    render(<ContextBar />);
    expect(screen.getByText("选区 0 × 0")).toBeInTheDocument();
    expect(screen.queryByText("裁到选区")).not.toBeInTheDocument();
    // Clearing it must still be reachable, or the user is stuck with a
    // selection they cannot dismiss.
    fireEvent.click(screen.getByText("清除选区"));
    expect(getState().region).toBeNull();
  });

  it("offers no crop for a selection that is only a line (one axis collapsed)", () => {
    setState({ region: rectRegion([30, 20, 30, 90]) });
    render(<ContextBar />);
    expect(screen.queryByText("裁到选区")).not.toBeInTheDocument();
  });

  it("reports the marquee size and crops to it", () => {
    setState({ region: rectRegion([10, 20, 132, 200]) });
    render(<ContextBar />);
    expect(screen.getByText("选区 180 × 122")).toBeInTheDocument();
    fireEvent.click(screen.getByText("裁到选区"));
    expect(dispatch).toHaveBeenCalledWith({ kind: "crop", payload: { rect: [10, 20, 132, 200] } });
  });

  // draggableIds (hit-test.ts) silently drops locked members of a mixed
  // selection from a drag — the context bar must say so, and say something
  // DIFFERENT for "all locked" vs "some locked", or a partial drag looks like
  // nothing happened at all.
  it("shows no lock hint when nothing in the selection is locked", () => {
    setState({
      selection: ["a"],
      doc: { canvas: { width: 100, height: 100 }, layers: [
        { id: "a", type: "raster", name: "a", opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 5, 5] },
      ] },
    });
    render(<ContextBar />);
    expect(screen.queryByText("已锁定")).not.toBeInTheDocument();
    expect(screen.queryByText("部分已锁定")).not.toBeInTheDocument();
  });

  it("shows 部分已锁定 for a mixed selection", () => {
    setState({
      selection: ["free", "pinned"],
      doc: { canvas: { width: 100, height: 100 }, layers: [
        { id: "free", type: "raster", name: "free", opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 5, 5] },
        { id: "pinned", type: "raster", name: "pinned", opacity: 1, blendMode: "normal", visible: true,
          bounds: [0, 0, 5, 5], locked: true },
      ] },
    });
    render(<ContextBar />);
    expect(screen.getByText("部分已锁定")).toBeInTheDocument();
    expect(screen.queryByText("已锁定")).not.toBeInTheDocument();
  });

  it("shows 已锁定 when every selected layer is locked", () => {
    setState({
      selection: ["pinned"],
      doc: { canvas: { width: 100, height: 100 }, layers: [
        { id: "pinned", type: "raster", name: "pinned", opacity: 1, blendMode: "normal", visible: true,
          bounds: [0, 0, 5, 5], locked: true },
      ] },
    });
    render(<ContextBar />);
    expect(screen.getByText("已锁定")).toBeInTheDocument();
    expect(screen.queryByText("部分已锁定")).not.toBeInTheDocument();
  });

  it("turns a region into the layers under it", () => {
    setState({
      region: rectRegion([0, 0, 30, 30]),
      doc: { canvas: { width: 100, height: 100 }, layers: [
        { id: "a", type: "raster", name: "a", opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 20, 20] },
        { id: "far", type: "raster", name: "far", opacity: 1, blendMode: "normal", visible: true, bounds: [80, 80, 99, 99] },
      ] },
    });
    render(<ContextBar />);
    fireEvent.click(screen.getByText("选中区域内的图层"));
    expect(getState().selection).toEqual(["a"]);
    // The two axes never clear each other (spec §3.3) — the region must survive
    // being read.
    expect(getState().region).not.toBeNull();
  });

  // `layerAlphaRegion` loops `alphaAt` once per pixel of the layer's box — for
  // a full-canvas layer in a real PSD that is tens of millions of iterations,
  // and the Worker queue only discards `hitTest && hover`, so tiles and
  // `applyOp` block behind it. Nothing dedupes the request either, so every
  // extra click used to queue another whole scan.
  it("disables 载入为选区 and shows progress while the scan is in flight", async () => {
    let finish = (): void => {};
    loadLayerAsRegion.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    oneLayerSelected();
    render(<ContextBar />);
    fireEvent.click(screen.getByText("载入为选区"));
    expect(screen.getByText("载入为选区")).toBeDisabled();
    expect(screen.getByText("正在载入选区…")).toBeInTheDocument();

    fireEvent.click(screen.getByText("载入为选区"));
    expect(loadLayerAsRegion).toHaveBeenCalledTimes(1);

    await act(async () => { finish(); });
    expect(screen.getByText("载入为选区")).not.toBeDisabled();
    expect(screen.queryByText("正在载入选区…")).not.toBeInTheDocument();
  });

  it("turns the selected layer into a region carrying its alpha", async () => {
    oneLayerSelected();
    render(<ContextBar />);
    fireEvent.click(screen.getByText("载入为选区"));
    await Promise.resolve(); await Promise.resolve();
    const region = getState().region!;
    expect(region.bounds).toEqual([10, 10, 12, 12]);
    expect(region.source).toBe("layerAlpha");
    expect(getMask(region.maskId)).toEqual(new Uint8ClampedArray([1, 2, 3, 4]));
    // The layer axis is untouched — the two conversions ADD an axis, they do
    // not swap one for the other (spec §3.3).
    expect(getState().selection).toEqual(["a"]);
  });
});
