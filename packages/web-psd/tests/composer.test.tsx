import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Composer } from "../src/ui/panels/composer.js";
import { getState, setSelection, setState } from "../src/ui/store.js";
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
    expect(onSend).toHaveBeenCalledWith("换成晚霞", { bounds: [20, 40, 120, 240], layers: [{ id: "a", name: "天空" }] });
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
    expect(onSend).toHaveBeenCalledWith("换成晚霞", { bounds: [0, 0, 50, 50], layers: [{ id: "a", name: "天空" }] });
  });

  // 图层选择也必须随指令走。以前只有拖出来的**选区**才附带 target，在图层
  // 面板里选中一层则什么都不附 —— 用户打"选中的图层中，网址改成 X"，agent
  // 收到的是一句指着它根本看不见的东西的话，只能靠 getLayers/getPreview 一层
  // 层猜。实测这样烧满 25 轮、182 秒，几乎不调图像模型。
  it("选中图层但没有选区时，附带图层的 id 和名字，且不编造 bounds", () => {
    setState({
      region: null, selection: ["b"],
      doc: { canvas: { width: 400, height: 200 }, layers: [
        leaf("a", "天空", [0, 0, 40, 40]), leaf("b", "网址", [100, 100, 150, 150]),
      ] },
    });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    send("网址改成 www.unidocs.com");
    // 没有 bounds：图层自己有 bounds，agent 从 getLayers 就能读到，这里编一个
    // 矩形等于替用户说了他没说的话。
    expect(onSend).toHaveBeenCalledWith("网址改成 www.unidocs.com", { layers: [{ id: "b", name: "网址" }] });
  });

  // chip 是「附带了什么」的唯一可见痕迹。断言刻意钉住**名字**而不是「有没有
  // 一颗 chip」：只写 `getByText(/已附带图层/)` 的话，把渲染条件写成常真、或者
  // 把名字换成 id、换成别的图层，都照样绿。
  it("选中图层时渲染一颗 chip，写明附带的是哪几层", () => {
    setState({
      region: null, selection: ["b", "c"],
      doc: { canvas: { width: 400, height: 200 }, layers: [
        leaf("a", "天空", [0, 0, 40, 40]), leaf("b", "网址", [100, 100, 150, 150]),
        leaf("c", "标语", [10, 10, 30, 30]),
      ] },
    });
    render(<Composer busy={false} onSend={vi.fn()} />);
    expect(screen.getByText("已附带图层 网址、标语")).toBeInTheDocument();
    // 没选中的那层不许出现在 chip 上。
    expect(screen.getByText(/已附带图层/).textContent).not.toContain("天空");
  });

  it("没有选中图层时不渲染图层 chip", () => {
    render(<Composer busy={false} onSend={vi.fn()} />);
    expect(screen.queryByText(/已附带图层/)).not.toBeInTheDocument();
  });

  // 两颗 chip 必须同形：同一套 class（外观）、同为可点的 button（交互）。
  it("图层 chip 与选区 chip 同形", () => {
    setState({ region: rectRegion([20, 40, 120, 240]), selection: [] });
    const { unmount } = render(<Composer busy={false} onSend={vi.fn()} />);
    const regionChip = screen.getByLabelText("不附带选区");
    const shape = [regionChip.tagName, regionChip.className, regionChip.getAttribute("type")];
    unmount();

    setState({ region: null, selection: ["a"] });
    render(<Composer busy={false} onSend={vi.fn()} />);
    const layerChip = screen.getByLabelText("不附带图层");
    expect([layerChip.tagName, layerChip.className, layerChip.getAttribute("type")]).toEqual(shape);
  });

  // 与选区 chip 同一条理由：附带的东西悄悄离开浏览器，所以要看得见、摘得掉。
  it("点掉图层 chip 之后不再附带，但选中状态本身不动", () => {
    setState({ region: null, selection: ["a"] });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    fireEvent.click(screen.getByLabelText("不附带图层"));
    expect(screen.queryByText(/已附带图层/)).not.toBeInTheDocument();
    send("随便改改");
    expect(onSend).toHaveBeenCalledWith("随便改改", null);
    // 摘的是「这次别附带」，不是「取消选中」—— 图层面板里那层仍然是选中的。
    expect(getState().selection).toEqual(["a"]);
  });

  // 取消按身份记：重新选一次是一个新的 selection 数组，chip 自己就回来了。
  it("摘掉后重新选中图层，chip 回来并重新附带", () => {
    setState({ region: null, selection: ["a"] });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    fireEvent.click(screen.getByLabelText("不附带图层"));
    act(() => setSelection(["a"]));
    expect(screen.getByText("已附带图层 天空")).toBeInTheDocument();
    send("换成晚霞");
    expect(onSend).toHaveBeenCalledWith("换成晚霞", { layers: [{ id: "a", name: "天空" }] });
  });

  // 互斥（spec §3.3）：有选区时图层那颗 chip 不许出现 —— 发出去的 target 里
  // 也没有它，显示一颗其实不会被发出去的 chip 比不显示更坏。
  it("有选区时只出现选区 chip", () => {
    setState({ region: rectRegion([20, 40, 120, 240]), selection: ["a"] });
    render(<Composer busy={false} onSend={vi.fn()} />);
    expect(screen.getByText(/已附带选区/)).toBeInTheDocument();
    expect(screen.queryByText(/已附带图层/)).not.toBeInTheDocument();
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
