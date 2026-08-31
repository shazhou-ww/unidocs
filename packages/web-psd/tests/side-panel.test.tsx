import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidePanel } from "../src/ui/panels/side-panel.js";
import { setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

vi.mock("../src/ui/controller.js", () => ({ dispatch: vi.fn() }));

const layer = (id: string, over: Partial<LocalLayer> = {}): LocalLayer => ({
  id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true,
  bounds: [0, 0, 10, 10], ...over,
});

beforeEach(() => {
  setState({
    selection: [], expanded: new Set(),
    doc: { canvas: { width: 10, height: 10 }, layers: [layer("bg"), layer("headline")] },
  });
});

describe("SidePanel", () => {
  // The two used to be tabs over one body, so seeing what a layer IS took a
  // second click and getting back to the tree took a third. Stacked, the
  // selection and the properties it drives are on screen together.
  it("shows the tree and the properties at once, with no tab to switch", () => {
    const { container } = render(<SidePanel />);
    expect(container.querySelector(".tree")).toBeInTheDocument();
    expect(container.querySelector(".props, .tree-empty")).toBeInTheDocument();
    expect(screen.getByText("图层")).toBeInTheDocument();
    expect(screen.getByText("属性")).toBeInTheDocument();
  });

  it("gives each half its own header count", () => {
    setState({ selection: ["headline"] });
    render(<SidePanel />);
    expect(screen.getByText("2 图层")).toBeInTheDocument();
    expect(screen.getByText("1 已选")).toBeInTheDocument();
  });

  it("renders the selected layer's properties next to the tree that selected it", () => {
    setState({ selection: ["headline"] });
    const { container } = render(<SidePanel />);
    expect(container.querySelector(".tree-row")).toBeInTheDocument();
    expect(screen.getByText("ir.root.headline")).toBeInTheDocument();
  });
});
