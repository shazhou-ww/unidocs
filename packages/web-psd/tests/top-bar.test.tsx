import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "../src/ui/panels/top-bar.js";
import { setState, getState } from "../src/ui/store.js";

const setZoom = vi.fn();
// A stage big enough for "fit" to be meaningful, and a canvas box that
// reports the document at 1:1 so `toCanvas`/`toScreen` behave like the real
// measured mapping does at zoom 1.
vi.mock("../src/ui/controller.js", () => ({
  getController: () => ({
    setZoom,
    stage: { clientWidth: 1000, clientHeight: 800, scrollLeft: 0, scrollTop: 0,
             getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }) },
    canvasRect: () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
  }),
  openFile: vi.fn(),
  exportUrl: () => "/tenants/u1/docs/psd/abc/export",
}));

beforeEach(() => {
  setZoom.mockClear();
  setState({ docName: "summer-sale-kv.psd", zoom: 1, version: 3, docId: "abcdef0123456789" });
});

describe("TopBar", () => {
  it("shows the document name", () => {
    render(<TopBar />);
    expect(screen.getByText("summer-sale-kv.psd")).toBeInTheDocument();
  });

  it("steps between ladder stops rather than by a fixed percentage", () => {
    render(<TopBar />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("放大"));
    expect(getState().zoom).toBeCloseTo(1.5);
    // The zoom VALUE lives in the store; the controller is only nudged to
    // re-fetch tiles, so it is called with no arguments.
    expect(setZoom).toHaveBeenCalledWith();
    // Wrap external store mutation in act() so React re-renders TopBar with the new zoom
    // before the click handler fires. Without act(), the handler closes over the previous
    // zoom value and computes the wrong result.
    act(() => { setState({ zoom: 1.5 }); });
    fireEvent.click(screen.getByLabelText("缩小"));
    expect(getState().zoom).toBeCloseTo(1);
  });

  it("saturates at the ends of the ladder", () => {
    render(<TopBar />);
    act(() => { setState({ zoom: 4 }); });
    fireEvent.click(screen.getByLabelText("放大"));
    expect(getState().zoom).toBe(4);
    act(() => { setState({ zoom: 0.05 }); });
    fireEvent.click(screen.getByLabelText("缩小"));
    expect(getState().zoom).toBe(0.05);
  });

  it("steps out of an off-ladder zoom in the direction asked", () => {
    // The wheel and "fit" both leave the zoom between stops.
    render(<TopBar />);
    act(() => { setState({ zoom: 0.37 }); });
    fireEvent.click(screen.getByLabelText("放大"));
    expect(getState().zoom).toBeCloseTo(0.5);
  });

  it("toggles the readout between fit and 100%", () => {
    render(<TopBar />);
    act(() => { setState({ doc: { canvas: { width: 2000, height: 1000 }, layers: [] } as never }); });
    // At 100% the readout offers "fit"; 2000 wide into 968 usable -> 0.484.
    fireEvent.click(screen.getByLabelText("适应窗口"));
    expect(getState().zoom).toBeCloseTo(0.484, 3);
    // Now off 100%, so it offers a way back to 1:1.
    act(() => { setState({ zoom: 0.484 }); });
    fireEvent.click(screen.getByLabelText("实际大小"));
    expect(getState().zoom).toBe(1);
  });

  it("keeps a decimal on very small zooms so they do not all read the same", () => {
    render(<TopBar />);
    act(() => { setState({ zoom: 0.05 }); });
    expect(screen.getByText("5.0%")).toBeInTheDocument();
    act(() => { setState({ zoom: 0.217 }); });
    expect(screen.getByText("22%")).toBeInTheDocument();
  });

  it("links export at the document's export endpoint", () => {
    render(<TopBar />);
    expect(screen.getByText("导出").closest("a")).toHaveAttribute(
      "href", "/tenants/u1/docs/psd/abc/export");
  });
});
