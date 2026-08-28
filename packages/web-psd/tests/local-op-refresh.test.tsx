import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import type { LocalLayer } from "../src/doc-model.js";
import type { Op } from "../src/doc-controller.js";

/**
 * C-1 regression. `DocSession.applyLocal` REPLACES the session's document with
 * a fresh object; `DocController.dispatch` must push that new document into the
 * UI store, or every panel that reads `store.doc` keeps rendering — and writing
 * from — pre-edit values.
 *
 * This wires the REAL `DocController.dispatch`, the REAL `ui/controller.ts`
 * onDoc→store wiring and the REAL `<LayerTree>` together, with only the
 * psd-client engine stubbed. The stub session actually applies the op to its
 * own doc and hands back a fresh object, exactly as `DocSession` does, so the
 * op genuinely round-trips: op → session.doc → store.doc → next render's
 * `!layer.visible`. A mock that merely recorded the op would assert nothing.
 */

// @unidocs/psd-client spins a Worker and talks to the gateway; none of it can
// run under jsdom. Only the shapes doc-controller.ts touches are stubbed.
vi.mock("@unidocs/psd-client", () => ({
  CasBlobStore: class {},
  DocSession: class {},
  RenderClient: class {},
  Viewport: class {},
  loadDoc: async () => { throw new Error("not used"); },
}));

const leaf = (id: string, over: Partial<LocalLayer> = {}): LocalLayer => ({
  id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, ...over,
});

/** Mirrors doctype-psd's `set_props`: returns a NEW doc with a NEW layer object
 *  for the target, leaving the input untouched — the same immutability contract
 *  `DocSession.applyLocal` gives DocController. */
function applySetProps(
  doc: { canvas: { width: number; height: number }; layers: LocalLayer[] },
  op: Op,
): { canvas: { width: number; height: number }; layers: LocalLayer[] } {
  const { layerId, props } = op.payload as { layerId: string; props: Partial<LocalLayer> };
  const walk = (list: LocalLayer[]): LocalLayer[] =>
    list.map((l) => (l.id === layerId
      ? { ...l, ...props }
      : l.children ? { ...l, children: walk(l.children) } : l));
  return { ...doc, layers: walk(doc.layers) };
}

beforeEach(() => {
  vi.resetModules();
  // `initController` kicks off `bootstrap()`, which fetches the bundled sample.
  // It must fail harmlessly: this test drives the session in directly.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in test"); }));
});

describe("local ops refresh the UI store", () => {
  it("re-hides and un-hides a layer: the second eye click sends visible:true", async () => {
    const { initController, getController } = await import("../src/ui/controller.js");
    const { getState } = await import("../src/ui/store.js");
    const { LayerTree } = await import("../src/ui/panels/layer-tree.js");

    const applied: Op[] = [];
    const session = {
      doc: { canvas: { width: 4, height: 4 }, layers: [leaf("t", { name: "headline" })] },
      version: 5,
      async applyLocal(op: Op): Promise<[number, number, number, number]> {
        applied.push(op);
        session.doc = applySetProps(session.doc, op);
        return [0, 0, 4, 4];
      },
    };

    initController(document.createElement("canvas"), document.createElement("div"));
    const controller = getController()!;
    // `session` is private and normally built by `initRender`, which needs a
    // real Worker + gateway. Injecting the stub is the only way to exercise
    // `dispatch` end to end under jsdom.
    (controller as unknown as { session: unknown }).session = session;
    // Seed the store the way a cold start would.
    await act(async () => { (controller as unknown as { events: { onDoc(d: unknown, v: number): void } }).events.onDoc(session.doc, session.version); });

    render(<LayerTree />);
    expect(screen.getByLabelText("隐藏 headline")).toHaveTextContent("●");

    await act(async () => { fireEvent.click(screen.getByLabelText("隐藏 headline")); });

    // The store — not just the session — must now hold the hidden layer, and
    // the glyph must have flipped.
    expect(getState().doc!.layers[0].visible).toBe(false);
    expect(screen.getByLabelText("显示 headline")).toHaveTextContent("○");

    await act(async () => { fireEvent.click(screen.getByLabelText("显示 headline")); });

    expect(applied).toEqual([
      { kind: "set_props", payload: { layerId: "t", props: { visible: false } } },
      { kind: "set_props", payload: { layerId: "t", props: { visible: true } } },
    ]);
    expect(getState().doc!.layers[0].visible).toBe(true);
  });

  it("keeps the version badge on the session's acked version, which a local op does not advance", async () => {
    const { initController, getController } = await import("../src/ui/controller.js");
    const { getState } = await import("../src/ui/store.js");

    const session = {
      doc: { canvas: { width: 4, height: 4 }, layers: [leaf("t")] },
      version: 5,
      async applyLocal(op: Op): Promise<[number, number, number, number]> {
        session.doc = applySetProps(session.doc, op);
        return [0, 0, 4, 4];
      },
    };
    initController(document.createElement("canvas"), document.createElement("div"));
    const controller = getController()!;
    (controller as unknown as { session: unknown }).session = session;

    await controller.dispatch({ kind: "set_props", payload: { layerId: "t", props: { visible: false } } });

    expect(getState().doc!.layers[0].visible).toBe(false);
    // The background drain has not acked yet; the badge lagging is by design.
    expect(getState().version).toBe(5);
  });
});
