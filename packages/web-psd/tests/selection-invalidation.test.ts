import { describe, it, expect } from "vitest";
import { invalidateTarget } from "../src/ui/invalidate.js";
import { rectRegion } from "../src/ui/region.js";
import type { LocalLayer } from "../src/doc-model.js";
import type { UiState } from "../src/ui/store.js";

const leaf = (id: string, children?: LocalLayer[]): LocalLayer => ({
  id, type: children ? "group" : "raster", name: id,
  opacity: 1, blendMode: "normal", visible: true, ...(children ? { children } : {}),
});

const doc = (w: number, h: number, layers: LocalLayer[]) =>
  ({ canvas: { width: w, height: h }, layers });

const prev = (over: Partial<Pick<UiState, "doc" | "selection" | "region">> = {}) => ({
  doc: doc(100, 80, [leaf("g", [leaf("b")]), leaf("a")]) as UiState["doc"],
  selection: ["b", "a"],
  region: rectRegion([10, 10, 50, 50]),
  ...over,
});

describe("invalidateTarget", () => {
  it("clears BOTH axes when a different document is opened", () => {
    expect(invalidateTarget(prev(), doc(64, 64, [leaf("x")]), true))
      .toEqual({ selection: [], region: null });
  });

  // crop rewrites canvas.width/height and shifts every layer by -[left,top]
  // (geometry-ops.ts). A kept region would be read against the NEW canvas by
  // rectStyle and land somewhere that is neither its old nor its new place.
  it("clears the region when the canvas size changes, and keeps the layers", () => {
    const p = prev();
    expect(invalidateTarget(p, doc(40, 40, p.doc!.layers), false))
      .toEqual({ region: null });
  });

  it("prunes ids of deleted layers instead of clearing the whole selection", () => {
    const p = prev();
    expect(invalidateTarget(p, doc(100, 80, [leaf("a")]), false))
      .toEqual({ selection: ["a"] });
  });

  it("leaves both axes alone when layers merely moved", () => {
    const p = prev();
    expect(invalidateTarget(p, doc(100, 80, [leaf("g", [leaf("b")]), leaf("a")]), false))
      .toEqual({});
  });

  it("survives the empty first screen, where there is no previous document", () => {
    expect(invalidateTarget({ doc: null, selection: [], region: null }, doc(10, 10, []), true))
      .toEqual({});
  });
});
