import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LayerTree } from "../src/ui/panels/layer-tree.js";
import { setState, getState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const dispatch = vi.fn();
vi.mock("../src/ui/controller.js", () => ({ dispatch: (op: unknown) => dispatch(op) }));

const leaf = (id: string, over: Partial<LocalLayer> = {}): LocalLayer => ({
  id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, ...over,
});

beforeEach(() => {
  dispatch.mockClear();
  setState({
    selection: [], expanded: new Set(),
    doc: { canvas: { width: 4, height: 4 }, layers: [
      leaf("g", { type: "group", name: "角标组", children: [leaf("badge", { name: "促销角标" })] }),
      leaf("t", { type: "text", name: "headline", degraded: [{ reason: "文字层已栅格化" }] }),
    ] },
  });
});

describe("LayerTree", () => {
  it("renders only top-level rows until a group is expanded", () => {
    render(<LayerTree />);
    expect(screen.queryByText("促销角标")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("展开 角标组"));
    expect(getState().expanded.has("g")).toBe(true);
    expect(screen.getByText("促销角标")).toBeInTheDocument();
  });

  it("shows a kind badge per layer type", () => {
    render(<LayerTree />);
    expect(screen.getByText("GRP")).toBeInTheDocument();
    expect(screen.getByText("T")).toBeInTheDocument();
  });

  it("marks degraded layers", () => {
    render(<LayerTree />);
    expect(screen.getByTitle("文字层已栅格化")).toBeInTheDocument();
  });

  it("selects on click and adds on meta-click", () => {
    render(<LayerTree />);
    fireEvent.click(screen.getByText("角标组"));
    expect(getState().selection).toEqual(["g"]);
    fireEvent.click(screen.getByText("headline"), { metaKey: true });
    expect(getState().selection).toEqual(["g", "t"]);
  });

  it("toggles visibility through a set_props op without changing selection", () => {
    render(<LayerTree />);
    fireEvent.click(screen.getByLabelText("隐藏 headline"));
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "t", props: { visible: false } },
    });
    expect(getState().selection).toEqual([]);
  });
});
