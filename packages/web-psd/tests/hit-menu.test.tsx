import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { App } from "../src/ui/app.js";
import { getState, setState } from "../src/ui/store.js";
import { rectRegion } from "../src/ui/region.js";
import type { LocalLayer } from "../src/doc-model.js";

const { dispatch, hitTest } = vi.hoisted(() => ({ dispatch: vi.fn(), hitTest: vi.fn() }));
// `vi.mock` replaces the WHOLE module, so every export any rendered component
// imports has to be here — see canvas-stage-select.test.tsx.
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    requestVisibleTiles: vi.fn(),
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    hitTest,
  }),
  dispatch,
  exportUrl: () => null,
  openFile: vi.fn(),
}));

const leaf = (id: string, bounds: [number, number, number, number], over: Partial<LocalLayer> = {}): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds, ...over });

/** Lets the awaited hit settle before assertions: the handler chains two
 *  microtasks (the hitTest promise, then `.then`). Unlike
 *  canvas-stage-select.test.tsx's version, this one has to be wrapped in
 *  `act()`: the menu's `useState` update happens outside any React event
 *  handler (inside the resolved-promise callback), so React schedules the
 *  re-render through its normal scheduler rather than flushing synchronously
 *  — `act()` drains that queue instead of requiring a real timer tick. The
 *  other tests in this plan never needed this because they read `getState()`
 *  directly rather than asserting on rendered DOM. */
const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

const stageOf = (container: HTMLElement): Element => container.querySelector("div.stage")!;

// See canvas-stage-drag.test.tsx: jsdom 25 has no PointerEvent constructor, so
// a MouseEvent named "pointer*" is what carries clientX/Y — and `button` — to
// React's handlers.
const pointer = (type: string, clientX: number, clientY: number, init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true, ...init });

beforeEach(() => {
  dispatch.mockClear();
  hitTest.mockReset();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  setState({
    tool: "move", region: null, selection: [], pickedColor: null, expanded: new Set(),
    docId: "doc-1",
    doc: { canvas: { width: 100, height: 100 }, layers: [
      { id: "g", type: "group", name: "g", opacity: 1, blendMode: "normal", visible: true,
        bounds: [0, 0, 0, 0], children: [leaf("top", [10, 10, 30, 30])] },
      leaf("bg", [0, 0, 100, 100]),
    ] },
  });
});

describe("HitMenu", () => {
  const stack = [
    { layerId: "top", path: ["g", "top"] },
    { layerId: "bg", path: ["bg"] },
  ];

  // One click landing on several plausible layers is the normal case in a PSD,
  // so the whole stack is offered instead of the code guessing.
  it("lists every candidate under the cursor, topmost first", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    const items = [...container.querySelectorAll(".hit-menu button")].map((b) => b.textContent);
    expect(items).toEqual(["top", "bg"]);
  });

  it("selects the one that is clicked and closes", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    fireEvent.click(container.querySelectorAll(".hit-menu button")[1]);
    expect(getState().selection).toEqual(["bg"]);
    expect(container.querySelector(".hit-menu")).toBeNull();
  });

  it("closes on Escape without changing the selection", async () => {
    setState({ selection: ["b"] });
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".hit-menu")).toBeNull();
    expect(getState().selection).toEqual(["b"]);
  });

  it("renders nothing when the cursor is over empty canvas", async () => {
    hitTest.mockResolvedValue([]);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 90, clientY: 90 });
    await flush();
    expect(container.querySelector(".hit-menu")).toBeNull();
  });

  // `app.tsx`'s `useSelectionShortcuts` binds its own Escape listener on
  // `window`, unconditionally, at mount — before the menu ever opens. A
  // bubble-phase listener registered later here would always lose that race
  // (same node, same phase, registration order — `stopImmediatePropagation`
  // can't retroactively stop a listener that already ran), so this needs
  // `<App />` mounted (not `<CanvasStage />` alone) to actually exercise the
  // conflict, and the Escape needs to originate from a real focused node —
  // dispatching directly on `window` collapses capture/bubble into a single
  // phase and would not distinguish a correct fix from a broken one.
  it("closing the menu via Escape does not also fire the app-level Escape shortcut", async () => {
    setState({ selection: ["bg"], region: rectRegion([0, 0, 10, 10]) });
    hitTest.mockResolvedValue(stack);
    const { container } = render(<App />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    expect(container.querySelector(".hit-menu")).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape", bubbles: true });
    expect(container.querySelector(".hit-menu")).toBeNull();
    expect(getState().selection).toEqual(["bg"]);
    expect(getState().region).not.toBeNull();
  });

  // `CanvasStage` is never re-keyed on a new document (app.tsx renders it
  // unconditionally), so this component and its in-flight hit test survive a
  // document swap. Without a staleness check, a right-click followed by
  // opening a different document before the hit resolves would show the OLD
  // document's layers, positioned in the old canvas's coordinates.
  //
  // Keyed to `docId`, not `doc` — see controller.ts's `sessionDocId` for the
  // same distinction drawn for the same reason. This test represents a
  // genuine open: a NEW `docId` alongside the new `doc` object.
  it("shows no menu if the document changes before the hit test resolves", async () => {
    const resolvers: Array<(hits: typeof stack) => void> = [];
    hitTest.mockImplementation(() => new Promise<typeof stack>((resolve) => { resolvers.push(resolve); }));
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    setState({ docId: "doc-2", doc: { canvas: { width: 50, height: 50 }, layers: [leaf("new", [0, 0, 50, 50])] } });
    resolvers[0](stack);
    await flush();
    expect(container.querySelector(".hit-menu")).toBeNull();
  });

  // `onDoc` (controller.ts) replaces `doc` with a fresh object on every
  // dispatched op, every rebase, and every agent reconcile — not only on a
  // genuine open (doc-controller.ts's `applyLocal`/`repaintAfterDocChange`/
  // `reconcile`). An identity check on `doc` itself would trip on any of
  // those landing while a right-click's hit test is in flight, silently
  // swallowing the menu for a document that never actually changed — the
  // same silent-wrong-result failure this whole plan has been closing. This
  // is the case the wholesale-swap test above cannot see: same `docId`, a
  // brand new `doc` object (an unrelated edit), and the menu must still show.
  it("still shows the menu if an unrelated edit replaces the doc object while the hit test is in flight", async () => {
    const resolvers: Array<(hits: typeof stack) => void> = [];
    hitTest.mockImplementation(() => new Promise<typeof stack>((resolve) => { resolvers.push(resolve); }));
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    // Same `docId` — this is what an edit's `onDoc` callback does, not what
    // opening a different document does.
    setState({ doc: { canvas: { width: 100, height: 100 }, layers: [leaf("bg", [0, 0, 100, 100])] } });
    resolvers[0](stack);
    await flush();
    expect(container.querySelector(".hit-menu")).not.toBeNull();
  });

  // Spec §9 applies to every canvas selection, and a menu pick is one — the
  // whole point of the menu is reaching a layer buried under others, which is
  // exactly the layer the tree is least likely to be showing already.
  it("expands the picked layer's ancestor groups", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    await flush();
    fireEvent.click(container.querySelectorAll(".hit-menu button")[0]);
    expect(getState().selection).toEqual(["top"]);
    expect(getState().expanded.has("g")).toBe(true);
  });

  // A browser sends `pointerdown` BEFORE `contextmenu` for a secondary click.
  // Every test above fires `contextMenu` alone and so never saw that the press
  // took pointer capture, fired its own hit test and selected `clickTarget`'s
  // guess — the menu then opened over a selection it had already disturbed,
  // and dismissing it with Escape left a selection nobody asked for. (On macOS
  // ⌃-click is the secondary click AND sets `ctrlKey`, so it also took the
  // ⌘/⌃-click "drill to the leaf" branch.)
  it("changes no selection when the secondary click's own pointerdown fires first", async () => {
    hitTest.mockResolvedValue(stack);
    const { container } = render(<CanvasStage />);
    const stage = stageOf(container);
    fireEvent(stage, pointer("pointerdown", 15, 15, { button: 2 }));
    fireEvent.contextMenu(stage, { clientX: 15, clientY: 15 });
    await flush();
    expect(getState().selection).toEqual([]);
    expect([...container.querySelectorAll(".hit-menu button")].map((b) => b.textContent)).toEqual(["top", "bg"]);
  });

  // `RenderClient.hitTest` really does reject. With no `.catch` here that was
  // an unhandled rejection plus a right-click that silently did nothing.
  it("reports a rejected hit test instead of silently doing nothing", async () => {
    let reject: (e: unknown) => void = () => {};
    hitTest.mockImplementation(() => new Promise((_resolve, rej) => { reject = rej; }));
    const { container } = render(<CanvasStage />);
    fireEvent.contextMenu(stageOf(container), { clientX: 15, clientY: 15 });
    reject(new Error("worker hit-test failed"));
    await flush();
    expect(container.querySelector(".hit-menu")).toBeNull();
    expect(getState().status).toContain("worker hit-test failed");
  });
});
