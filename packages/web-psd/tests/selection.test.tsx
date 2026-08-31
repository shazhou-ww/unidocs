import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolStrip } from "../src/ui/panels/tool-strip.js";
import { ContextBar } from "../src/ui/panels/context-bar.js";
import { setState, getState } from "../src/ui/store.js";
import { rectRegion } from "../src/ui/region.js";

const dispatch = vi.fn();
const pickColor = vi.fn(() => "#f5efe3");
vi.mock("../src/ui/controller.js", () => ({
  dispatch: (op: unknown) => dispatch(op),
  getController: () => ({ pickColor, toCanvas: (x: number, y: number) => ({ x, y }) }),
}));

beforeEach(() => {
  dispatch.mockClear();
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
});
