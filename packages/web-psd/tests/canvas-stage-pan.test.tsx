import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

// The move tool used to do nothing at all unless a layer had already been
// selected in the tree — a press on the canvas produced no cursor change and
// no movement, so the tool read as broken. It now pans the view (the hand
// gesture) whenever the press does NOT land on a selected layer, and still
// drags the layer when it does. These tests pin both halves of that fork and
// the cursor flags that advertise it.
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
  }),
  dispatch,
}));

// See canvas-stage-drag.test.tsx: jsdom 25 has no PointerEvent constructor,
// so a MouseEvent typed with a "pointer*" name is what carries clientX/Y
// through to React's pointer handlers.
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
    tool: "move", marquee: null, selection: [], pickedColor: null,
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

  it("dispatches no ops while panning, even with a layer selected off the press point", () => {
    setState({ selection: ["a"] }); // bounds [0,0,50,50]; the press is at 120,120
    const stage = mount();
    fireEvent(stage, pointer("pointerdown", 120, 120));
    fireEvent(stage, pointer("pointermove", 140, 120));
    expect(dispatch).not.toHaveBeenCalled();
    expect(stage.scrollLeft).toBe(-20);
  });

  it("drags the layer instead of panning when the press lands inside its bounds", () => {
    setState({ selection: ["a"] });
    const stage = mount();
    fireEvent(stage, pointer("pointerdown", 20, 20));
    fireEvent(stage, pointer("pointermove", 30, 20));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(stage.scrollLeft).toBe(0);
  });
});

describe("CanvasStage cursor flags", () => {
  it("names the active tool on the stage so CSS can pick the cursor", () => {
    const stage = mount();
    expect(stage.getAttribute("data-tool")).toBe("move");
    // Through `act` because the attribute is React-rendered, unlike the two
    // flags below which the pointer handlers write straight to the DOM.
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

  it("flags a hover over a selected layer, so it reads as movable rather than pannable", () => {
    setState({ selection: ["a"] });
    const stage = mount();
    fireEvent(stage, pointer("pointermove", 20, 20));
    expect(stage.hasAttribute("data-over-layer")).toBe(true);
    fireEvent(stage, pointer("pointermove", 120, 120));
    expect(stage.hasAttribute("data-over-layer")).toBe(false);
  });

  it("never flags a hover when nothing is selected — there is no layer to move", () => {
    const stage = mount();
    fireEvent(stage, pointer("pointermove", 20, 20));
    expect(stage.hasAttribute("data-over-layer")).toBe(false);
  });
});
