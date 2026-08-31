import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "../src/ui/panels/top-bar.js";
import { setState, getState } from "../src/ui/store.js";

const setZoom = vi.fn();
vi.mock("../src/ui/controller.js", () => ({
  getController: () => ({ setZoom }),
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

  it("steps zoom by 25% within 25%..400%", () => {
    render(<TopBar />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("放大"));
    expect(getState().zoom).toBeCloseTo(1.25);
    // The zoom VALUE lives in the store; the controller is only nudged to
    // re-fetch tiles, so it is called with no arguments.
    expect(setZoom).toHaveBeenCalledWith();
    // Wrap external store mutation in act() so React re-renders TopBar with the new zoom
    // before the click handler fires. Without act(), the handler closes over the previous
    // zoom value and computes the wrong result.
    act(() => { setState({ zoom: 4 }); });
    fireEvent.click(screen.getByLabelText("放大"));
    expect(getState().zoom).toBe(4); // clamped
    act(() => { setState({ zoom: 0.25 }); });
    fireEvent.click(screen.getByLabelText("缩小"));
    expect(getState().zoom).toBe(0.25); // clamped
  });

  it("links export at the document's export endpoint", () => {
    render(<TopBar />);
    expect(screen.getByText("导出").closest("a")).toHaveAttribute(
      "href", "/tenants/u1/docs/psd/abc/export");
  });
});
