import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { getState, setState } from "../src/ui/store.js";
import { getHoverId, setHoverId } from "../src/ui/overlay-store.js";
import type { LocalLayer } from "../src/doc-model.js";

const { hitTest } = vi.hoisted(() => ({ hitTest: vi.fn() }));
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    hitTest,
  }),
}));

// See canvas-stage-drag.test.tsx: jsdom 25 has no PointerEvent constructor, so
// a MouseEvent named "pointer*" is what carries clientX/Y to React's handlers.
// The optional `init` lets a caller add modifier keys (metaKey, shiftKey, …)
// without every existing call site having to pass one.
const pointer = (type: string, clientX: number, clientY: number, init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true, ...init });

const leaf = (id: string): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 100, 100] });

const group = (id: string, children: LocalLayer[]): LocalLayer =>
  ({ id, type: "group", name: id, opacity: 1, blendMode: "normal", visible: true, children });

/** Hands back a hit only when `settle()` is called, so the test can drive the
 *  exact interleaving a 20–30ms worker round trip produces. */
function deferredHit(hits: unknown) {
  let settle = (): void => {};
  hitTest.mockImplementation(() => new Promise((resolve) => { settle = () => resolve(hits); }));
  return async (): Promise<void> => { settle(); await Promise.resolve(); await Promise.resolve(); };
}

/** The mirror of `deferredHit` for the failure path: hands back the `reject`
 *  of whatever hit test the next gesture issues. */
function rejectingHit(): (e: unknown) => void {
  let reject: (e: unknown) => void = () => {};
  hitTest.mockImplementation(() => new Promise((_resolve, rej) => { reject = rej; }));
  return (e) => reject(e);
}

/** Drains the two microtasks a settled hit test chains (the promise itself,
 *  then its handler). */
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

const stageOf = (container: HTMLElement): Element => container.querySelector("div.stage")!;

beforeEach(() => {
  hitTest.mockReset();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({
    tool: "move", region: null, selection: [], pickedColor: null,
    doc: { canvas: { width: 100, height: 100 }, layers: [leaf("a")] },
  });
});


/** 点击 = 按下再松开,位移不超过 CLICK_SLOP_PX。命中在松开那一刻才发出。 */
const click = (stage: Element, x: number, y: number, init: MouseEventInit = {}): void => {
  fireEvent(stage, pointer("pointerdown", x, y, init));
  fireEvent(stage, pointer("pointerup", x, y, init));
};

describe("命中测试发生在松手时,不是按下时", () => {
  // 画布上的拖拽一律是平移(PR #41),所以命中不能在按下时发 —— 十次里八次
  // 是想平移,那八次会白跑一趟 Worker,还占着串行队列挡住瓦片。
  it("按下并拖动只平移,不发命中测试", () => {
    hitTest.mockResolvedValue([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 60, 10));
    fireEvent(stage, pointer("pointerup", 60, 10));
    expect(hitTest).not.toHaveBeenCalled();
    expect(getState().selection).toEqual([]);
  });

  it("按下后几乎没动就松开,判定为点击并选中", async () => {
    hitTest.mockResolvedValue([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 12, 11));   // 2px,在阈值内
    fireEvent(stage, pointer("pointerup", 12, 11));
    await flush();
    expect(getState().selection).toEqual(["a"]);
  });

  it("命中落空清空图层轴", async () => {
    setState({ selection: ["a"] });
    hitTest.mockResolvedValue([]);
    const { container } = render(<CanvasStage />);
    click(stageOf(container), 90, 90);
    await flush();
    expect(getState().selection).toEqual([]);
  });

  it("平移不清选中 —— 选中框跟着画布一起走", () => {
    setState({ selection: ["a"] });
    hitTest.mockResolvedValue([]);
    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 60, 40));
    fireEvent(stage, pointer("pointerup", 60, 40));
    expect(getState().selection).toEqual(["a"]);
  });

  it("画布选中会展开树里的祖先组(spec §9)", async () => {
    setState({
      selection: [],
      expanded: new Set(),
      doc: { canvas: { width: 100, height: 100 }, layers: [group("g1", [group("g2", [leaf("deep")])])] },
    });
    hitTest.mockResolvedValue([{ layerId: "deep", path: ["g1", "g2", "deep"] }]);
    const { container } = render(<CanvasStage />);
    click(stageOf(container), 15, 15, { metaKey: true });
    await flush();
    expect(getState().selection).toEqual(["deep"]);
    expect(getState().expanded.has("g1")).toBe(true);
    expect(getState().expanded.has("g2")).toBe(true);
  });
});

describe("一个递增令牌管住所有手势", () => {
  // 四种手势(点击/双击/Alt 循环/右键)都发异步命中,各自长一套作废规则就
  // 会互相覆盖。统一成一个令牌之后,永远是新的赢。
  it("在飞的双击下探不会被随后落地的单击结果覆盖", async () => {
    // 先选中 g,双击才有得下探:descendPath(["g","a"], "g") -> "a",
    // 而单击的 clickTarget 给的是最外层 "g"。两者必须不同,否则这条断言
    // 在两种实现下都会过、什么也钉不住。
    setState({
      selection: ["g"],
      doc: { canvas: { width: 100, height: 100 }, layers: [group("g", [leaf("a")])] },
    });
    const resolvers: Array<(v: unknown) => void> = [];
    hitTest.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    click(stage, 15, 15);                                      // 单击 -> resolvers[0]
    fireEvent.doubleClick(stage, { clientX: 15, clientY: 15 }); // 双击 -> resolvers[1]
    const hits = [{ layerId: "a", path: ["g", "a"] }];
    resolvers[1]?.(hits);   // 双击先回
    await flush();
    resolvers[0]?.(hits);   // 单击后回 —— 已被令牌作废,不该覆盖
    await flush();
    expect(getState().selection).toEqual(["a"]);
  });

  it("双击空白清空图层轴", async () => {
    setState({ selection: ["a"] });
    hitTest.mockResolvedValue([]);
    const { container } = render(<CanvasStage />);
    fireEvent.doubleClick(stageOf(container), { clientX: 90, clientY: 90 });
    await flush();
    expect(getState().selection).toEqual([]);
  });
});

describe("命中测试失败", () => {
  it("点击失败会上报,而不是静默无反应", async () => {
    const reject = rejectingHit();
    const { container } = render(<CanvasStage />);
    click(stageOf(container), 15, 15);
    reject(new Error("worker 挂了"));
    await flush();
    expect(getState().status).toContain("命中测试失败");
  });

  it("悬停失败只清掉高亮,不每帧上报", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    setHoverId("a");
    const reject = rejectingHit();
    const { container } = render(<CanvasStage />);
    fireEvent(stageOf(container), pointer("pointermove", 15, 15));
    reject(new Error("worker 挂了"));
    await flush();
    expect(getHoverId()).toBeNull();
    expect(getState().status).not.toContain("命中测试失败");
  });
});
