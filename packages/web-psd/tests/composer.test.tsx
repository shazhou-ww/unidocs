import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/ui/panels/composer.js";
import { setState } from "../src/ui/store.js";
import { rectRegion } from "../src/ui/region.js";
import type { LocalLayer } from "../src/doc-model.js";

const leaf = (id: string, name: string, bounds?: [number, number, number, number]): LocalLayer =>
  ({ id, type: "raster", name, opacity: 1, blendMode: "normal", visible: true, bounds });

beforeEach(() => {
  setState({
    region: null, selection: [],
    // 「天空」铺满画布 [top,left,bottom,right] = [0,0,200,400],所以任何
    // 区域都与它相交 —— targetLayerNames 走的是相交而不是选中。
    doc: { canvas: { width: 400, height: 200 }, layers: [leaf("a", "天空", [0, 0, 200, 400])] },
  });
});

const send = (text: string) => {
  fireEvent.change(screen.getByPlaceholderText(/说明要改什么/), { target: { value: text } });
  fireEvent.keyDown(screen.getByPlaceholderText(/说明要改什么/), { key: "Enter" });
};

describe("Composer", () => {
  it("sends no target when there is no region", () => {
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    expect(screen.queryByText(/已附带选区/)).not.toBeInTheDocument();
    send("随便改改");
    expect(onSend).toHaveBeenCalledWith("随便改改", null);
  });

  // 附带的图层清单是「与区域相交的图层」(spec §4.3),不是选中的图层 ——
  // 互斥之后有区域时选中集必然为空,「选中的图层」那条路根本走不到。
  it("shows a chip and attaches bounds plus the layers the region overlaps", () => {
    setState({ region: rectRegion([20, 40, 120, 240]), selection: [] });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    expect(screen.getByText("已附带选区 200 × 100")).toBeInTheDocument();
    send("换成晚霞");
    expect(onSend).toHaveBeenCalledWith("换成晚霞", { bounds: [20, 40, 120, 240], layerNames: ["天空"] });
  });

  // Spec §4.3's fourth field is「与区域相交的图层清单」— who is on top of this
  // area — not "who is selected". The flagship case ("regenerate the part I
  // boxed in") has a region and NO layer selection, and used to send bounds
  // with no layer list at all; spec §3.2 defines exactly that combination as
  // "all the layers in this region".
  it("attaches the layers the region intersects when nothing is selected", () => {
    setState({
      region: rectRegion([0, 0, 50, 50]), selection: [],
      doc: { canvas: { width: 400, height: 200 }, layers: [
        leaf("a", "天空", [0, 0, 40, 40]), leaf("b", "远山", [100, 100, 150, 150]),
      ] },
    });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    send("换成晚霞");
    expect(onSend).toHaveBeenCalledWith("换成晚霞", { bounds: [0, 0, 50, 50], layerNames: ["天空"] });
  });

  // Attaching on every turn is required (by turn three, "a bit more to the
  // left" has to still mean the same patch) — so the user must be able to SEE
  // it and take it off, or state leaves the browser without their knowledge.
  it("stops attaching once the chip is dismissed, without clearing the region", () => {
    setState({ region: rectRegion([20, 40, 120, 240]) });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    fireEvent.click(screen.getByLabelText("不附带选区"));
    expect(screen.queryByText(/已附带选区/)).not.toBeInTheDocument();
    send("换成晚霞");
    expect(onSend).toHaveBeenCalledWith("换成晚霞", null);
  });
});
