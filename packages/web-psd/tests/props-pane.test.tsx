import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PropsPane } from "../src/ui/panels/props-pane.js";
import { getState, setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const dispatch = vi.fn();
// Opt-in round trip: applies the op to `store.doc` the way
// DocController.dispatch does, so the pane re-renders off the new document.
const roundTrip = { value: false };
vi.mock("../src/ui/controller.js", () => ({
  dispatch: (op: unknown) => {
    dispatch(op);
    if (!roundTrip.value) return;
    const { layerId, props } = (op as { payload: { layerId: string; props: Partial<LocalLayer> } }).payload;
    const doc = getState().doc!;
    setState({ doc: { ...doc, layers: doc.layers.map((l) => (l.id === layerId ? { ...l, ...props } : l)) } });
  },
}));

const STROKE = { color: { r: 255, g: 0, b: 0 }, opacity: 1, size: 3, position: "outside", blendMode: "normal" };

const layer = (over: Partial<LocalLayer> = {}): LocalLayer => ({
  id: "badge", type: "fill", name: "促销角标",
  opacity: 1, blendMode: "normal", visible: true,
  bounds: [214, 462, 336, 642], ...over,
});

beforeEach(() => {
  dispatch.mockClear();
  roundTrip.value = false;
  setState({ selection: ["badge"], doc: { canvas: { width: 800, height: 600 }, layers: [layer({ stroke: STROKE })] } });
});

describe("PropsPane", () => {
  it("prompts when nothing is selected", () => {
    setState({ selection: [] });
    render(<PropsPane />);
    expect(screen.getByText("未选中图层")).toBeInTheDocument();
  });

  it("derives x/y and w/h from bounds", () => {
    render(<PropsPane />);
    expect(screen.getByText("462, 214")).toBeInTheDocument();  // left, top
    expect(screen.getByText("180 × 122")).toBeInTheDocument(); // right-left, bottom-top
  });

  it("writes opacity through set_props", () => {
    render(<PropsPane />);
    fireEvent.change(screen.getByLabelText("不透明度"), { target: { value: "50" } });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "badge", props: { opacity: 0.5 } },
    });
  });

  it("writes blendMode through set_props", () => {
    render(<PropsPane />);
    fireEvent.change(screen.getByLabelText("混合模式"), { target: { value: "multiply" } });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "badge", props: { blendMode: "multiply" } },
    });
  });

  it("changes an existing stroke's size", () => {
    render(<PropsPane />);
    fireEvent.change(screen.getByLabelText("描边宽度"), { target: { value: "8" } });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "badge", props: { stroke: { ...STROKE, size: 8 } } },
    });
  });

  // The C-1 consequence that cost data: `writeEffect` SPREADS the current
  // stroke (`{ ...stroke, size }`). If the pane keeps reading a store copy
  // that a local op never refreshed, the second write carries the stale
  // colour and silently reverts the first. Covered end to end (through the
  // real DocController) in local-op-refresh.test.tsx; this pins the pane's
  // half: given a store that DOES refresh, consecutive effect edits compose.
  it("composes consecutive effect edits instead of reverting the earlier one", () => {
    roundTrip.value = true;
    render(<PropsPane />);
    fireEvent.change(screen.getByLabelText("描边颜色"), { target: { value: "#00ff00" } });
    expect(dispatch).toHaveBeenLastCalledWith({
      kind: "set_props",
      payload: { layerId: "badge", props: { stroke: { ...STROKE, color: { r: 0, g: 255, b: 0 } } } },
    });

    fireEvent.change(screen.getByLabelText("描边宽度"), { target: { value: "8" } });
    expect(dispatch).toHaveBeenLastCalledWith({
      kind: "set_props",
      payload: { layerId: "badge", props: { stroke: { ...STROKE, color: { r: 0, g: 255, b: 0 }, size: 8 } } },
    });
  });

  it("removes an effect by sending null", () => {
    render(<PropsPane />);
    fireEvent.click(screen.getByLabelText("移除描边"));
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "badge", props: { stroke: null } },
    });
  });

  it("shows an IR snippet without pixels or children", () => {
    setState({ doc: { canvas: { width: 800, height: 600 },
      layers: [{
        ...layer(),
        pixels: { width: 180, height: 122 },
        mask: { pixels: { width: 180, height: 122 } },
        children: [layer({ id: "kid" })],
      } as LocalLayer] } });
    render(<PropsPane />);
    const snippet = screen.getByLabelText("IR 片段").textContent!;
    expect(snippet).toContain('"id": "badge"');
    expect(snippet).not.toContain("children");
    expect(snippet).not.toContain("pixels");
    expect(snippet).not.toContain("mask");
  });

  it("only writes an effect to selected layers that already have it", () => {
    setState({
      selection: ["badge", "plain"],
      doc: {
        canvas: { width: 800, height: 600 },
        layers: [layer({ stroke: STROKE }), layer({ id: "plain", name: "无描边" })],
      },
    });
    render(<PropsPane />);
    fireEvent.change(screen.getByLabelText("描边宽度"), { target: { value: "8" } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      kind: "set_props", payload: { layerId: "badge", props: { stroke: { ...STROKE, size: 8 } } },
    });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ layerId: "plain" }) }),
    );
  });
});
