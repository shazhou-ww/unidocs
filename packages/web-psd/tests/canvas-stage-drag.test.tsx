import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { setState } from "../src/ui/store.js";

// Regression guard for the anti-drift arithmetic in canvas-stage.tsx's
// onPointerMove: `drag.current.last` must advance by the WHOLE PIXELS
// actually dispatched (`ops[0].payload.op.translate`), never snapped to the
// raw pointer position `to`. If `last` were set to `to`, every sub-pixel
// remainder `translateOps` discards would be re-discarded on the next frame
// too, and a sustained slow drag would never cross a whole-pixel threshold
// at all — the layer would silently never move. This is invisible to
// `drag.test.ts` (which only unit-tests the pure `translateOps` function),
// so it needs its own regression test that drives real pointer frames.
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
  }),
  dispatch,
}));

// jsdom 25 has no `PointerEvent` constructor at all (`window.PointerEvent`
// is undefined), so `fireEvent.pointerDown`/`pointerMove` silently fall back
// to a bare `Event`, which drops `clientX`/`clientY` entirely (verified
// directly: a listener sees `clientX === undefined`). `MouseEvent`, typed
// with a "pointer*" event name, IS a real jsdom constructor that honours
// `clientX`/`clientY` in its init dict and still reaches React's pointer
// handlers, since React only inspects the fired properties, not the event's
// class. `pointerId` ends up undefined either way; harmless here because
// `setPointerCapture`/`releasePointerCapture` are stubbed below and ignore it.
function pointer(type: "pointerdown" | "pointermove", clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
}

beforeEach(() => {
  dispatch.mockClear();
  // jsdom 25 also does not implement the Pointer Capture API —
  // `setPointerCapture`/`releasePointerCapture` are `undefined` on
  // HTMLElement — but canvas-stage.tsx calls them unconditionally on
  // pointerdown/pointerup. Stub them so a synthetic drag can run without
  // throwing.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({ tool: "move", marquee: null, selection: ["a"], pickedColor: null });
});

describe("CanvasStage move-tool drag", () => {
  it("accumulates sub-pixel pointer movement into whole-pixel translate deltas, never losing the remainder", () => {
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;

    // Pointer creeps from x=10 to x=11.2 in three 0.4px steps: no single
    // step crosses a whole pixel on its own, but the true cumulative move
    // (1.2px) should still round to 1 dispatched pixel once frames are
    // accumulated correctly.
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 10.4, 10));
    fireEvent(stage, pointer("pointermove", 10.8, 10));
    fireEvent(stage, pointer("pointermove", 11.2, 10));

    const totalDx = dispatch.mock.calls
      .map((args) => (args[0].payload.op as { translate: [number, number] }).translate[0])
      .reduce((a: number, b: number) => a + b, 0);

    expect(totalDx).toBe(1);
  });
});
