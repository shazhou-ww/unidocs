import { describe, it, expect } from "vitest";
import type { Layer } from "../src/model/types.js";
import { findLayer, findParentList, removeById, insertAt, isDescendant } from "../src/model/tree.js";

function leaf(id: string): Layer {
  return { id, type: "raster", name: id, bounds: [0, 0, 1, 1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false };
}

describe("tree helpers", () => {
  it("finds nested layer and its parent list", () => {
    const g: Layer = { ...leaf("g"), type: "group", children: [leaf("a"), leaf("b")] };
    const layers = [leaf("root0"), g];
    expect(findLayer(layers, "b")?.id).toBe("b");
    const p = findParentList(layers, "b")!;
    expect(p.list).toBe(g.children);
    expect(p.index).toBe(1);
  });

  it("removes by id and reports descendants", () => {
    const g: Layer = { ...leaf("g"), type: "group", children: [leaf("a")] };
    const layers = [g];
    expect(isDescendant(g, "a")).toBe(true);
    expect(isDescendant(g, "zzz")).toBe(false);
    expect(removeById(layers, "a")?.id).toBe("a");
    expect(g.children).toHaveLength(0);
  });

  it("insertAt pushes when index omitted", () => {
    const list = [leaf("a")];
    insertAt(list, leaf("b"));
    expect(list.map((l) => l.id)).toEqual(["a", "b"]);
    insertAt(list, leaf("c"), 0);
    expect(list.map((l) => l.id)).toEqual(["c", "a", "b"]);
  });
});
