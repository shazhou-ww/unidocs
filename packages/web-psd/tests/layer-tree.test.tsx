import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { LayerTree } from "../src/ui/panels/layer-tree.js";
import { setState, getState, selectLayer } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const dispatch = vi.fn();
// Opt-in round trip: when enabled, the mock APPLIES the op to `store.doc` the
// way DocController.dispatch does, so the tree re-renders off the new document.
const roundTrip = { value: false };
vi.mock("../src/ui/controller.js", () => ({
  dispatch: (op: unknown) => {
    dispatch(op);
    if (!roundTrip.value) return;
    const { layerId, props } = (op as { payload: { layerId: string; props: Partial<LocalLayer> } }).payload;
    const doc = getState().doc!;
    const walk = (list: LocalLayer[]): LocalLayer[] =>
      list.map((l) => (l.id === layerId ? { ...l, ...props } : l.children ? { ...l, children: walk(l.children) } : l));
    setState({ doc: { ...doc, layers: walk(doc.layers) } });
  },
}));

const leaf = (id: string, over: Partial<LocalLayer> = {}): LocalLayer => ({
  id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, ...over,
});

beforeEach(() => {
  dispatch.mockClear();
  roundTrip.value = false;
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
    // Toggling the caret must not move the selection, same guarantee as the eye.
    expect(getState().selection).toEqual([]);
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

  // The eye is a TOGGLE, so it is only correct if the row re-reads the layer
  // after the op landed. `roundTrip` stands in for the real pipeline
  // (DocController.dispatch -> session.applyLocal -> onDoc -> store), which is
  // covered end to end in local-op-refresh.test.tsx; here it pins the panel's
  // half of the contract: a store update must flip both the glyph and the next
  // op's payload. A dispatch mock that only recorded the op would pass even
  // with the store frozen.
  it("un-hides on the second click once the op round-trips through the store", () => {
    roundTrip.value = true;
    render(<LayerTree />);
    fireEvent.click(screen.getByLabelText("隐藏 headline"));
    expect(getState().doc!.layers[1].visible).toBe(false);
    expect(screen.getByLabelText("显示 headline")).toHaveTextContent("○");

    fireEvent.click(screen.getByLabelText("显示 headline"));
    expect(dispatch).toHaveBeenLastCalledWith({
      kind: "set_props", payload: { layerId: "t", props: { visible: true } },
    });
    expect(getState().doc!.layers[1].visible).toBe(true);
  });

  // flattenTree emits a group's children only when the group is expanded, so a
  // selection made anywhere else — the canvas, the degradation badge — lands on
  // a row that is not being rendered at all.
  it("expands the ancestors of a layer selected from outside the tree", () => {
    const { rerender } = render(<LayerTree />);
    expect(screen.queryByText("促销角标")).not.toBeInTheDocument();
    act(() => { selectLayer("badge"); });
    rerender(<LayerTree />);
    expect(getState().expanded.has("g")).toBe(true);
    expect(screen.getByText("促销角标")).toBeInTheDocument();
  });

  it("scrolls the selected row into view", () => {
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    setState({ selection: ["t"] });
    render(<LayerTree />);
    expect(into).toHaveBeenCalledWith({ block: "nearest" });
  });
});
