import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { applyOne } from "../src/ops/index.js";
import { opDirtyRect, opActiveIndex } from "../src/render/dirty-rect.js";

const canvas = { width: 100, height: 100, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };
const px = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const raster = (id: string, bounds: [number,number,number,number], over: Partial<Layer> = {}): Layer => ({
  id, type: "raster", name: id, bounds, opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false, pixels: px(bounds[3]-bounds[1], bounds[2]-bounds[0]), ...over,
});
const doc = (layers: Layer[]): PsdDoc => ({ canvas, layers });

describe("opDirtyRect", () => {
  it("set_props on a layer → that layer's influence bounds", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    const op = { kind: "set_props", payload: { layerId: "a", props: { opacity: 0.5 } } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 20, 20]);
  });

  it("transform move → union of old and new positions", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    // geometry-ops: translate is a [dx,dy] tuple; shiftBounds adds dx to
    // left/right, dy to top/bottom. [10,10,20,20] + [30,30] → [40,40,50,50].
    const op = { kind: "transform", payload: { layerId: "a", op: { translate: [30, 30] } } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 50, 50]); // union of old+new
  });

  it("remove_layer → the removed layer's old influence", () => {
    const before = doc([raster("a", [10, 10, 20, 20]), raster("b", [50, 50, 60, 60])]);
    const op = { kind: "remove_layer", payload: { layerId: "a" } };
    const after = applyOne(before, op);
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 20, 20]);
  });

  it("crop → full canvas", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    const op = { kind: "crop", payload: { rect: [0, 0, 50, 50] } };
    const after = applyOne(before, op);
    const r = opDirtyRect(op, before, after);
    expect(r[0]).toBe(0); expect(r[1]).toBe(0); // top-left of full canvas
  });

  it("unknown/absent layerId → full canvas (conservative)", () => {
    const before = doc([raster("a", [10, 10, 20, 20])]);
    const op = { kind: "set_props", payload: { layerId: "nope", props: {} } };
    const after = before;
    expect(opDirtyRect(op, before, after)).toEqual([0, 0, 100, 100]);
  });

  it("reorder structural change with clipping layer → full canvas", () => {
    // A clip layer's output depends on the nearest non-clipping visible layer below it.
    // Reordering a layer can change which layer is the clip-base, affecting the clip layer
    // far outside the reordered layer's own bounds.
    const before = doc([
      raster("far", [0, 0, 10, 10]),
      raster("base", [50, 50, 90, 90]),
      raster("clip", [50, 50, 90, 90], { clipping: true }),
    ]);
    const op = { kind: "reorder", payload: { layerId: "far", parentId: null, index: 1 } };
    const after = applyOne(before, op);
    // The actual change is at the clip layer's bounds [50,50,90,90], far outside far's [0,0,10,10].
    // opDirtyRect must return full canvas to be conservative.
    expect(opDirtyRect(op, before, after)).toEqual([0, 0, 100, 100]);
  });

  it("set_props toggling visible on clip-base → full canvas", () => {
    // Hiding the clip-base layer changes which layer is the clip-base, affecting clipped layers.
    const before = doc([
      raster("base", [50, 50, 90, 90]),
      raster("clip", [50, 50, 90, 90], { clipping: true }),
    ]);
    const op = { kind: "set_props", payload: { layerId: "base", props: { visible: false } } };
    const after = applyOne(before, op);
    // The clip layer's output changes, but not due to the base's own influence bounds.
    // Fall back to full canvas when clipping layers exist and visibility changes.
    expect(opDirtyRect(op, before, after)).toEqual([0, 0, 100, 100]);
  });

  it("reorder without clipping layers → tight union rule (regression guard)", () => {
    // When no clipping layers are present, the tight union rule still applies.
    // This guards against over-broad fallback.
    const before = doc([
      raster("a", [10, 10, 20, 20]),
      raster("b", [50, 50, 60, 60]),
    ]);
    const op = { kind: "reorder", payload: { layerId: "a", parentId: null, index: 1 } };
    const after = applyOne(before, op);
    // Should be the union of a's influence before and after (no structural coupling).
    expect(opDirtyRect(op, before, after)).toEqual([10, 10, 20, 20]);
  });
});

const group = (id: string, children: Layer[], over: Partial<Layer> = {}): Layer => ({
  id, type: "group", name: id, bounds: [0, 0, 100, 100], opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false, children, ...over,
});

describe("opActiveIndex", () => {
  it("set_props on the k-th top-level layer → k", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10]), raster("c", [0, 0, 10, 10])]);
    const op = { kind: "set_props", payload: { layerId: "b", props: { opacity: 0.5 } } };
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(1);
  });

  it("set_props on a group's child → the group's top-level index (top ancestor)", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), group("g", [raster("child", [0, 0, 10, 10])])]); // g at index 1
    const op = { kind: "set_props", payload: { layerId: "child", props: { opacity: 0.5 } } };
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(1);
  });

  it("reorder → min(old top index, new top index)", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10]), raster("c", [0, 0, 10, 10])]); // c at 2
    const op = { kind: "reorder", payload: { layerId: "c", parentId: null, index: 0 } }; // c: 2 → 0
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(0); // min(2, 0)
  });

  it("crop → 0", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10])]);
    const op = { kind: "crop", payload: { rect: [0, 0, 5, 5] } };
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(0);
  });

  it("remove_layer → the removed layer's top index in before (absent from after)", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10]), raster("c", [0, 0, 10, 10])]);
    const op = { kind: "remove_layer", payload: { layerId: "b" } }; // index 1 in before, gone in after
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(1);
  });

  it("add_layer at top index i → i (new layer absent from before)", () => {
    const before = doc([raster("a", [0, 0, 10, 10]), raster("b", [0, 0, 10, 10])]);
    const op = { kind: "add_layer", payload: { layer: raster("n", [0, 0, 10, 10]), parentId: null, index: 1 } };
    const after = applyOne(before, op);
    expect(opActiveIndex(op, before, after)).toBe(1);
  });

  it("set_props on an absent layer → 0 (conservative)", () => {
    const before = doc([raster("a", [0, 0, 10, 10])]);
    const op = { kind: "set_props", payload: { layerId: "nope", props: {} } };
    expect(opActiveIndex(op, before, before)).toBe(0);
  });
});
