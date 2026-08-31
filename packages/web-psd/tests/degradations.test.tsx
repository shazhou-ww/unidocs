import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopBar } from "../src/ui/panels/top-bar.js";
import { setState, getState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

vi.mock("../src/ui/controller.js", () => ({
  getController: () => ({ requestVisibleTiles: vi.fn() }), openFile: vi.fn(), exportDoc: vi.fn(),
}));

const layer = (id: string, over: Partial<LocalLayer> = {}): LocalLayer => ({
  id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, ...over,
});

beforeEach(() => {
  setState({ docName: "a.psd", zoom: 1, version: 7, selection: [],
    doc: { canvas: { width: 4, height: 4 }, layers: [
      layer("g", { type: "group", children: [layer("b")] }),
      layer("t", { type: "text", name: "headline",
                   degraded: [{ reason: "文字层已栅格化", detail: "本期不支持编辑文字" }] }),
    ] } });
});

describe("top bar badges", () => {
  it("shows the real document version and a recursive layer count", () => {
    render(<TopBar />);
    expect(screen.getByText("v7 · 3 图层")).toBeInTheDocument();
  });

  it("counts degradations and reveals them on click", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByText("1 项降级 ›"));
    expect(screen.getByText("文字层已栅格化")).toBeInTheDocument();
    expect(screen.getByText("本期不支持编辑文字")).toBeInTheDocument();
  });

  // Selecting is now the whole jump: the right column stacks the tree and
  // the properties instead of tabbing between them (see side-panel.tsx), so
  // there is no pane left to switch to.
  it("jumps to the offending layer's properties", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByText("1 项降级 ›"));
    fireEvent.click(screen.getByText("headline"));
    expect(getState().selection).toEqual(["t"]);
  });

  it("hides the badge when nothing was degraded", () => {
    setState({ doc: { canvas: { width: 4, height: 4 }, layers: [layer("a")] } });
    render(<TopBar />);
    expect(screen.queryByText(/项降级/)).not.toBeInTheDocument();
  });
});
