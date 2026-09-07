import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

// Dragging the canvas pans it, always. The move tool used to translate the
// selected layers instead — and did nothing whatsoever when nothing was
// selected, which is the state the app starts in, so the tool read as broken.
// The tests that matter are therefore the ones proving the fork is GONE: no
// selection, and no press position, changes what a drag does.
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    // 位移小于 CLICK_SLOP_PX 的 pointerup 会被 canvas-stage 当成点击,走
    // `c.hitTest(...).then(...)`。这个替身缺了它时,那条路径抛的
    // `TypeError: c.hitTest is not a function` 逃进事件处理器、被 vitest 记成
    // unhandled error —— 7 条断言照样绿,包却以非零码退出。断言不覆盖的分支
    // 也得能跑通,替身才算跟得上真实接口。
    hitTest: () => Promise.resolve([]),
  }),
  dispatch,
}));

// See canvas-stage-marquee.test.tsx: jsdom 25 has no PointerEvent
// constructor, so a MouseEvent typed with a "pointer*" name is what carries
// clientX/Y through to React's pointer handlers.
function pointer(type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
}

const layer = (over: Partial<LocalLayer> = {}): LocalLayer => ({
  id: "a", type: "raster", name: "a", opacity: 1, blendMode: "normal", visible: true, ...over,
});

function mount(): HTMLElement {
  const { container } = render(<CanvasStage />);
  const stage = container.querySelector("div.stage") as HTMLElement;
  // jsdom lays nothing out, so `.stage` has no scrollable overflow and
  // assigning scrollLeft/scrollTop would be clamped straight back to 0.
  // Redefine them as plain writable numbers: what is under test is the
  // arithmetic the handler writes, not the browser's scroll clamping.
  Object.defineProperty(stage, "scrollLeft", { value: 0, writable: true, configurable: true });
  Object.defineProperty(stage, "scrollTop", { value: 0, writable: true, configurable: true });
  return stage;
}

beforeEach(() => {
  dispatch.mockClear();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({
    tool: "move", region: null, selection: [], pickedColor: null,
    doc: { canvas: { width: 200, height: 200 }, layers: [layer({ bounds: [0, 0, 50, 50] })] },
  });
});

describe("CanvasStage move-tool pan", () => {
  it("scrolls the stage opposite to the drag, so the content follows the cursor", () => {
    const stage = mount();
    stage.scrollLeft = 100;
    stage.scrollTop = 80;

    fireEvent(stage, pointer("pointerdown", 60, 60));
    fireEvent(stage, pointer("pointermove", 75, 90));

    // Dragged +15/+30, so the view moves -15/-30 to keep the grabbed point
    // under the cursor.
    expect(stage.scrollLeft).toBe(85);
    expect(stage.scrollTop).toBe(50);
  });

  it("computes every frame from the original press rather than accumulating deltas", () => {
    const stage = mount();
    stage.scrollLeft = 100;

    fireEvent(stage, pointer("pointerdown", 60, 60));
    fireEvent(stage, pointer("pointermove", 70, 60));
    fireEvent(stage, pointer("pointermove", 65, 60));

    // Back to 5px right of the press, so 5px scrolled — not 10 then 15.
    expect(stage.scrollLeft).toBe(95);
  });

  it("stops panning on pointerup", () => {
    const stage = mount();
    fireEvent(stage, pointer("pointerdown", 60, 60));
    fireEvent(stage, pointer("pointerup", 60, 60));
    fireEvent(stage, pointer("pointermove", 200, 200));
    expect(stage.scrollLeft).toBe(0);
  });

  it("pans, not moves, when the press lands right on the selected layer", () => {
    setState({ selection: ["a"] }); // bounds [0,0,50,50] — the press is inside it
    const stage = mount();
    fireEvent(stage, pointer("pointerdown", 20, 20));
    fireEvent(stage, pointer("pointermove", 30, 25));
    expect(stage.scrollLeft).toBe(-10);
    expect(stage.scrollTop).toBe(-5);
  });

  it("never dispatches an op from a canvas drag, selected layer or not", () => {
    setState({ selection: ["a"] });
    const stage = mount();
    fireEvent(stage, pointer("pointerdown", 20, 20));
    fireEvent(stage, pointer("pointermove", 30, 20));
    fireEvent(stage, pointer("pointermove", 41, 20));
    fireEvent(stage, pointer("pointerup", 41, 20));
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("CanvasStage cursor flags", () => {
  it("names the active tool on the stage so CSS can pick the cursor", () => {
    const stage = mount();
    expect(stage.getAttribute("data-tool")).toBe("move");
    // Through `act` because the attribute is React-rendered, unlike
    // `data-panning` below which the pointer handlers write to the DOM.
    act(() => { setState({ tool: "marquee" }); });
    expect(stage.getAttribute("data-tool")).toBe("marquee");
  });

  it("marks the press as a pan only for as long as it lasts", () => {
    const stage = mount();
    expect(stage.hasAttribute("data-panning")).toBe(false);
    fireEvent(stage, pointer("pointerdown", 60, 60));
    expect(stage.hasAttribute("data-panning")).toBe(true);
    fireEvent(stage, pointer("pointerup", 60, 60));
    expect(stage.hasAttribute("data-panning")).toBe(false);
  });
});
