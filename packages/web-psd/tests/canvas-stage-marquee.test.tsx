import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CanvasStage, normalise } from "../src/ui/panels/canvas-stage.js";
import { getState, setState } from "../src/ui/store.js";

// The pointer handlers sit on `.stage`, which is `overflow: auto` and larger
// than the canvas whenever the document is smaller than the viewport, so a
// drag that begins (or ends) in the grey surround yields coordinates outside
// the document. `crop` writes `doc.canvas.width = right - left` with no
// validation of its own, so an unclamped marquee could ENLARGE the canvas
// past its content — and a click with no movement could commit a 0x0 one.
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
  }),
  dispatch: vi.fn(),
}));

// See canvas-stage-drag.test.tsx: jsdom 25 has no PointerEvent constructor,
// so a MouseEvent typed with a "pointer*" name is what carries clientX/Y
// through to React's pointer handlers.
function pointer(type: "pointerdown" | "pointermove", clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
}

beforeEach(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({
    tool: "marquee", region: null, selection: [], pickedColor: null,
    doc: { canvas: { width: 100, height: 60 }, layers: [] },
  });
});

describe("normalise", () => {
  const canvas = { width: 100, height: 60 };

  it("orders the corners regardless of drag direction", () => {
    expect(normalise({ x: 80, y: 40 }, { x: 20, y: 10 }, canvas)).toEqual([10, 20, 40, 80]);
  });

  it("clamps a drag that starts and ends outside the document", () => {
    expect(normalise({ x: -50, y: -30 }, { x: 400, y: 500 }, canvas)).toEqual([0, 0, 60, 100]);
  });

  it("clamps only the out-of-document edge", () => {
    expect(normalise({ x: 10, y: 5 }, { x: 400, y: 20 }, canvas)).toEqual([5, 10, 20, 100]);
  });

  it("collapses a wholly out-of-document drag to a zero-area rect rather than an inverted one", () => {
    const r = normalise({ x: 200, y: 200 }, { x: 300, y: 300 }, canvas);
    expect(r).toEqual([60, 100, 60, 100]);
    expect(r[2] - r[0]).toBe(0);
    expect(r[3] - r[1]).toBe(0);
  });

  it("leaves coordinates alone before a document is loaded", () => {
    expect(normalise({ x: -5, y: -5 }, { x: 400, y: 400 }, null)).toEqual([-5, -5, 400, 400]);
  });
});

describe("CanvasStage marquee", () => {
  it("never stores a marquee that reaches past the document", () => {
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;

    fireEvent(stage, pointer("pointerdown", -40, -25));
    fireEvent(stage, pointer("pointermove", 500, 400));

    expect(getState().region?.bounds).toEqual([0, 0, 60, 100]);
  });

  it("a click with no movement produces a zero-area marquee, which the context bar must refuse to crop", () => {
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;

    // A bare pointerdown clears the marquee outright, but browsers fire a
    // pointermove for any jitter — including a zero-delta one — which is how
    // a real click leaves a zero-area rect behind. ContextBar's own guard is
    // covered in selection.test.tsx.
    fireEvent(stage, pointer("pointerdown", 30, 30));
    expect(getState().region).toBeNull();

    fireEvent(stage, pointer("pointermove", 30, 30));
    const m = getState().region!.bounds;
    expect(m).toEqual([30, 30, 30, 30]);
    expect(m[2] - m[0]).toBe(0);
  });
});
