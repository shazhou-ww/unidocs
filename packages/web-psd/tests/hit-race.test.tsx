import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { getState, setState } from "../src/ui/store.js";
import type { LocalLayer } from "../src/doc-model.js";

const { dispatch, hitTest } = vi.hoisted(() => ({ dispatch: vi.fn(), hitTest: vi.fn() }));
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    hitTest,
  }),
  dispatch,
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

beforeEach(() => {
  dispatch.mockClear();
  hitTest.mockReset();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({
    tool: "move", region: null, selection: [], pickedColor: null,
    doc: { canvas: { width: 100, height: 100 }, layers: [leaf("a")] },
  });
});

const totalDx = (): number => dispatch.mock.calls
  .map((args) => (args[0].payload.op as { translate: [number, number] }).translate[0])
  .reduce((a: number, b: number) => a + b, 0);

describe("async hit + press-to-drag", () => {
  it("dispatches nothing while the hit test is still in flight", async () => {
    const settle = deferredHit([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 22, 10));
    expect(dispatch).not.toHaveBeenCalled();
    await settle();
    expect(getState().selection).toEqual(["a"]);
  });

  // Using the coordinate the hit came back AT would swallow the movement made
  // during the round trip and the layer would visibly jump behind the cursor.
  it("moves the layer by the FULL finger travel once the hit lands", async () => {
    const settle = deferredHit([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 22, 10));
    await settle();
    expect(totalDx()).toBe(12);
    fireEvent(stage, pointer("pointermove", 30, 10));
    expect(totalDx()).toBe(20);
  });

  it("degrades to a plain click when the pointer is released before the hit lands", async () => {
    const settle = deferredHit([{ layerId: "a", path: ["a"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 22, 10));
    fireEvent(stage, pointer("pointerup", 22, 10));
    await settle();
    expect(getState().selection).toEqual(["a"]);
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent(stage, pointer("pointermove", 40, 10));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("clears the layer axis on a miss and leaves the region alone", async () => {
    // The shared `leaf("a")` fixture covers the whole 100x100 canvas, which
    // would make EVERY point read as "inside the current selection" and take
    // the synchronous drag path (never reaching the async hit test this case
    // means to exercise). Shrinking "a"'s bounds here keeps (90,90) genuinely
    // outside it, so the press has to go through `hitTest` and can actually miss.
    setState({
      doc: { canvas: { width: 100, height: 100 }, layers: [{ ...leaf("a"), bounds: [0, 0, 10, 10] }] },
      selection: ["a"], region: { bounds: [0, 0, 10, 10], source: "rect", maskId: null },
    });
    const settle = deferredHit([]);
    const { container } = render(<CanvasStage />);
    fireEvent(container.querySelector("div.stage")!, pointer("pointerdown", 90, 90));
    await settle();
    expect(getState().selection).toEqual([]);
    expect(getState().region).not.toBeNull();
  });

  it("drags the existing selection with no round trip when the press is inside it", () => {
    setState({ selection: ["a"] });
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 15, 10));
    expect(hitTest).not.toHaveBeenCalled();
    expect(totalDx()).toBe(5);
  });

  // Regression for review finding 1: the synchronous "keep dragging the
  // current selection" branch used to leave a still-in-flight `pending` from
  // an EARLIER, since-released gesture untouched. When that stale hit landed
  // later, `settleHit`'s "a newer gesture superseded this one" guard read the
  // stale pointer as still current and overwrote the selection mid-drag.
  it("a stale hit does not clobber the selection established by a newer synchronous drag", async () => {
    setState({
      selection: ["a"],
      doc: {
        canvas: { width: 100, height: 100 },
        layers: [{ ...leaf("a"), bounds: [0, 0, 10, 10] }, { ...leaf("b"), bounds: [20, 20, 100, 100] }],
      },
    });
    const settleFirst = deferredHit([{ layerId: "b", path: ["b"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;

    // 1. Press OUTSIDE "a"'s box: selection is non-empty but this point isn't
    //    inside it, so this takes the async path — `pending` is now in flight.
    fireEvent(stage, pointer("pointerdown", 50, 50));
    // 2. Released before that hit test answers.
    fireEvent(stage, pointer("pointerup", 50, 50));
    // 3. A whole new press, this time INSIDE "a"'s box — the synchronous
    //    "continue dragging the current selection" branch.
    fireEvent(stage, pointer("pointerdown", 5, 5));
    fireEvent(stage, pointer("pointermove", 8, 5));
    expect(totalDx()).toBe(3);

    // 4. The FIRST press's hit test finally lands, resolving to "b". It must
    //    be discarded — the second, synchronous gesture already superseded it.
    await settleFirst();
    expect(getState().selection).toEqual(["a"]);
  });

  // Regression for review finding 2: `RenderClient.hitTest` really does
  // reject on a Worker-side error. Without a `.catch`, `pending` was never
  // cleared on that path (plus an unhandled rejection), which otherwise has
  // no test coverage since every other case here resolves.
  it("a rejected hit test clears `pending` instead of wedging the gesture", async () => {
    let reject: (e: unknown) => void = () => {};
    hitTest.mockImplementation(() => new Promise((_resolve, rej) => { reject = rej; }));
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10));
    reject(new Error("worker hit-test failed"));
    // Flushes the `.catch` microtask. If it is missing, this `it` itself
    // fails with an unhandled rejection rather than the assertion below.
    await Promise.resolve();
    await Promise.resolve();

    // A fresh gesture afterwards must behave normally — nothing left over
    // from the dead hit test blocks it.
    setState({ selection: ["a"] });
    fireEvent(stage, pointer("pointerdown", 10, 10));
    fireEvent(stage, pointer("pointermove", 15, 10));
    expect(totalDx()).toBe(5);
  });

  // Regression for review finding 3: the hit branch of `settleHit` used to
  // write the selection with a raw `setState`, skipping `selectLayer`'s
  // ancestor expansion (spec §9) — a canvas click on a layer nested inside
  // collapsed groups left the tree showing none of them.
  it("expands the tree's ancestor groups when a canvas hit selects a nested layer", async () => {
    setState({
      selection: [], expanded: new Set(),
      doc: { canvas: { width: 100, height: 100 }, layers: [group("g1", [group("g2", [leaf("leaf1")])])] },
    });
    // ⌘/Ctrl-click drills to the leaf (`p.leaf`), which is nested two groups
    // deep — the only way to actually exercise ancestor expansion, since a
    // plain click selects the top-level group, which has no ancestors.
    const settle = deferredHit([{ layerId: "leaf1", path: ["g1", "g2", "leaf1"] }]);
    const { container } = render(<CanvasStage />);
    const stage = container.querySelector("div.stage")!;
    fireEvent(stage, pointer("pointerdown", 10, 10, { metaKey: true }));
    await settle();
    expect(getState().selection).toEqual(["leaf1"]);
    expect(getState().expanded.has("g1")).toBe(true);
    expect(getState().expanded.has("g2")).toBe(true);
  });
});
