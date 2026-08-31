import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "../src/ui/panels/top-bar.js";
import { setState, getState } from "../src/ui/store.js";

const requestVisibleTiles = vi.fn();
// `vi.hoisted` because the mock factory below is hoisted above this file's
// top-level bindings and references `exportDoc` eagerly (unlike
// `requestVisibleTiles`, which is only read inside a lazy getter).
const { exportDoc } = vi.hoisted(() => ({ exportDoc: vi.fn(async () => {}) }));
// A stage big enough for "fit" to be meaningful, and a canvas box that
// reports the document at 1:1 so `toCanvas`/`toScreen` behave like the real
// measured mapping does at zoom 1.
vi.mock("../src/ui/controller.js", () => ({
  getController: () => ({
    requestVisibleTiles,
    stage: { clientWidth: 1000, clientHeight: 800, scrollLeft: 0, scrollTop: 0,
             getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }) },
    canvasRect: () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
  }),
  openFile: vi.fn(),
  exportDoc,
}));

beforeEach(() => {
  requestVisibleTiles.mockClear();
  exportDoc.mockClear();
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

  // Export is a BUTTON, not an <a href> — it has to flush the pending-op
  // queue to the server before reading the document back from it, and a plain
  // link navigates without running a line of JS.
  it("runs the export through exportDoc rather than navigating to a URL", () => {
    render(<TopBar />);
    const button = screen.getByRole("button", { name: "导出" });
    expect(button.closest("a")).toBeNull();
    fireEvent.click(button);
    expect(exportDoc).toHaveBeenCalledTimes(1);
  });

  it("goes busy while exporting so a second click cannot fire a second export", () => {
    render(<TopBar />);
    act(() => { setState({ exporting: true }); });
    const button = screen.getByRole("button", { name: "导出中…" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(exportDoc).not.toHaveBeenCalled();
  });

  it("offers no export at all until a document is open", () => {
    render(<TopBar />);
    act(() => { setState({ docId: null }); });
    expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
  });
});
