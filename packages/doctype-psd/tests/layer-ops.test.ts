import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { addLayer, removeLayer, reorder, setProps } from "../src/ops/layer-ops.js";
import { findLayer, findParentList } from "../src/model/tree.js";

const leaf = (id: string): Layer => ({ id, type: "raster", name: id, bounds: [0,0,1,1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false });
const doc = (): PsdDoc => ({ canvas: { width: 10, height: 10, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [leaf("a")] });

describe("layer ops", () => {
  it("add_layer inserts at root end and at index", () => {
    const d = doc();
    addLayer(d, { layer: leaf("b"), parentId: null });
    expect(d.layers.map(l => l.id)).toEqual(["a", "b"]);
    addLayer(d, { layer: leaf("c"), parentId: null, index: 0 });
    expect(d.layers.map(l => l.id)).toEqual(["c", "a", "b"]);
  });

  it("add_layer rejects duplicate id", () => {
    const d = doc();
    expect(() => addLayer(d, { layer: leaf("a"), parentId: null })).toThrow(/exists/);
  });

  it("add_layer into a group", () => {
    const d = doc();
    const g: Layer = { ...leaf("g"), type: "group", children: [] };
    addLayer(d, { layer: g, parentId: null });
    addLayer(d, { layer: leaf("x"), parentId: "g" });
    expect(findParentList(d.layers, "x")!.list).toBe((findLayer(d.layers, "g") as Layer).children);
  });

  it("remove_layer removes; missing throws", () => {
    const d = doc();
    removeLayer(d, { layerId: "a" });
    expect(d.layers).toHaveLength(0);
    expect(() => removeLayer(d, { layerId: "nope" })).toThrow(/not found/);
  });

  it("reorder moves across parents; rejects cycle", () => {
    const d = doc();
    const g: Layer = { ...leaf("g"), type: "group", children: [leaf("child")] };
    addLayer(d, { layer: g, parentId: null });
    reorder(d, { layerId: "a", parentId: "g", index: 0 });
    expect((findLayer(d.layers, "g") as Layer).children!.map(l => l.id)).toEqual(["a", "child"]);
    expect(() => reorder(d, { layerId: "g", parentId: "child", index: 0 })).toThrow(/cycle/);
  });

  it("set_props merges allowed; rejects immutable + bad values", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { opacity: 0.5, blendMode: "multiply", visible: false } });
    const a = findLayer(d.layers, "a")!;
    expect(a.opacity).toBe(0.5);
    expect(a.blendMode).toBe("multiply");
    expect(() => setProps(d, { layerId: "a", props: { id: "z" } as any })).toThrow(/immutable|unknown/);
    expect(() => setProps(d, { layerId: "a", props: { opacity: 5 } })).toThrow(/opacity/);
    expect(() => setProps(d, { layerId: "a", props: { blendMode: "bogus" as any } })).toThrow(/blendMode/);
  });
});
