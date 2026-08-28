import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PropsPane } from "../src/ui/panels/props-pane.js";
import { setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const dispatch = vi.fn();
vi.mock("../src/ui/controller.js", () => ({ dispatch: (op: unknown) => dispatch(op) }));

const STROKE = { color: { r: 255, g: 0, b: 0 }, opacity: 1, size: 3, position: "outside", blendMode: "normal" };

const layer = (over: Partial<LocalLayer> = {}): LocalLayer => ({
  id: "badge", type: "fill", name: "促销角标",
  opacity: 1, blendMode: "normal", visible: true,
  bounds: [214, 462, 336, 642], ...over,
});

beforeEach(() => {
  dispatch.mockClear();
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
