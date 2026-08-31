import { describe, it, expect } from "vitest";
import {
  findLayer, unionRect, layerBox, layersIntersecting, normalizeSelection, expandAncestors,
  clickTarget, descendPath, draggableIds,
} from "../src/ui/hit-test.js";
import type { LocalLayer, Rect } from "../src/doc-model.js";

const leaf = (id: string, bounds: Rect, over: Partial<LocalLayer> = {}): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds, ...over });

const group = (id: string, children: LocalLayer[], over: Partial<LocalLayer> = {}): LocalLayer =>
  ({ id, type: "group", name: id, opacity: 1, blendMode: "normal", visible: true,
     bounds: [0, 0, 0, 0], children, ...over });

describe("layerBox", () => {
  it("returns a leaf's own bounds", () => {
    expect(layerBox(leaf("a", [10, 10, 20, 20]))).toEqual([10, 10, 20, 20]);
  });

  // psd/load.ts maps ag-psd's top/left/bottom/right for EVERY layer, and a PSD
  // section divider reports 0,0,0,0 — a group has no space of its own, it is a
  // render scope. Trusting `bounds` here would put every group's selection box
  // in the top-left corner at zero size.
  it("unions the children when the group's own bounds are the usual 0,0,0,0", () => {
    const g = group("g", [leaf("a", [10, 10, 20, 20]), leaf("b", [40, 5, 50, 30])]);
    expect(layerBox(g)).toEqual([10, 5, 50, 30]);
  });

  it("ignores hidden children and returns null when none are visible", () => {
    expect(layerBox(group("g", [leaf("a", [10, 10, 20, 20], { visible: false })]))).toBeNull();
  });

  it("nests", () => {
    const g = group("outer", [group("inner", [leaf("a", [0, 0, 5, 5])]), leaf("b", [90, 90, 100, 100])]);
    expect(layerBox(g)).toEqual([0, 0, 100, 100]);
  });
});

describe("unionRect", () => {
  it("takes the outermost edge on each side", () => {
    expect(unionRect([10, 20, 30, 40], [5, 25, 35, 35])).toEqual([5, 20, 35, 40]);
  });
});

describe("layersIntersecting", () => {
  const layers = [leaf("bg", [0, 0, 100, 100]), leaf("a", [10, 10, 20, 20]), leaf("far", [90, 90, 99, 99])];

  it("collects every top-level layer whose box meets the region, over-selecting rather than missing", () => {
    expect(layersIntersecting(layers, [0, 0, 30, 30])).toEqual(["bg", "a"]);
  });

  it("excludes layers that only touch the region's edge", () => {
    expect(layersIntersecting([leaf("a", [0, 0, 10, 10])], [10, 10, 20, 20])).toEqual([]);
  });

  it("skips groups with no visible children, which have no box at all", () => {
    expect(layersIntersecting([group("g", [leaf("h", [0, 0, 5, 5], { visible: false })])], [0, 0, 10, 10]))
      .toEqual([]);
  });
});

describe("normalizeSelection", () => {
  const layers = [group("g", [leaf("b", [0, 0, 1, 1]), leaf("c", [0, 0, 1, 1])]), leaf("a", [0, 0, 1, 1])];

  // geometry-ops.ts's shiftLayer recurses into children while drag.ts emits one
  // translate PER SELECTED ID — so a group plus its own child means the child
  // moves twice. See drag-normalize.test.ts for the end-to-end version.
  it("drops a member whose ancestor is also selected", () => {
    expect(normalizeSelection(layers, ["g", "b"])).toEqual(["g"]);
  });

  it("keeps siblings, which are not ancestors of each other", () => {
    expect(normalizeSelection(layers, ["b", "c"])).toEqual(["b", "c"]);
  });

  it("prunes ids that are not in the document at all", () => {
    expect(normalizeSelection(layers, ["a", "ghost"])).toEqual(["a"]);
  });

  it("dedupes", () => {
    expect(normalizeSelection(layers, ["a", "a"])).toEqual(["a"]);
  });

  it("preserves click order", () => {
    expect(normalizeSelection(layers, ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("findLayer / expandAncestors", () => {
  const layers = [group("outer", [group("inner", [leaf("deep", [0, 0, 1, 1])])]), leaf("a", [0, 0, 1, 1])];

  it("finds through nesting", () => {
    expect(findLayer(layers, "deep")?.name).toBe("deep");
    expect(findLayer(layers, "nope")).toBeNull();
  });

  // flattenTree only emits a group's children when the group is in `expanded`,
  // so selecting something from the canvas without this leaves the user looking
  // at a tree that does not contain what they just selected.
  it("adds every ancestor group of the target, and not the target itself", () => {
    const next = expandAncestors(layers, "deep", new Set(["keep"]));
    expect([...next].sort()).toEqual(["inner", "keep", "outer"]);
  });

  it("returns the same set object when nothing needs opening", () => {
    const before = new Set(["x"]);
    expect(expandAncestors(layers, "a", before)).toBe(before);
  });
});

describe("clickTarget", () => {
  const canvas = { width: 100, height: 100 };
  const tree = [group("root", [group("mid", [leaf("deep", [10, 10, 20, 20])])])];

  it("selects the outermost group, the Figma semantics", () => {
    const shallow = [group("g", [leaf("a", [10, 10, 20, 20])]), leaf("b", [0, 0, 5, 5])];
    expect(clickTarget(shallow, ["g", "a"], canvas)).toBe("g");
  });

  // "Everything in one root group" is common in a PSD. Selecting it puts the
  // box flush against the canvas edge — no information at all — and dragging
  // translates the entire document.
  it("descends past a group that covers most of the canvas", () => {
    const wide = [group("root", [leaf("bg", [0, 0, 100, 100]), leaf("a", [10, 10, 20, 20])])];
    expect(clickTarget(wide, ["root", "a"], canvas)).toBe("a");
  });

  it("keeps descending while each level is still too big, stopping at the leaf", () => {
    const nested = [group("root", [group("mid", [leaf("full", [0, 0, 100, 100])])])];
    expect(clickTarget(nested, ["root", "mid", "full"], canvas)).toBe("full");
  });

  it("returns the leaf when the path has no groups in it", () => {
    expect(clickTarget(tree, ["deep"], canvas)).toBe("deep");
  });
});

describe("descendPath", () => {
  it("moves one level deeper on each call and stops at the leaf", () => {
    expect(descendPath(["a", "b", "c"], "a")).toBe("b");
    expect(descendPath(["a", "b", "c"], "b")).toBe("c");
    expect(descendPath(["a", "b", "c"], "c")).toBe("c");
  });

  it("starts at the outermost level when the current id is not on the path", () => {
    expect(descendPath(["a", "b", "c"], "elsewhere")).toBe("a");
  });
});

describe("draggableIds", () => {
  it("drops locked layers, which nothing in the engine refuses on its own", () => {
    const layers = [leaf("free", [0, 0, 5, 5]), leaf("pinned", [0, 0, 5, 5], { locked: true })];
    expect(draggableIds(layers, ["free", "pinned"])).toEqual(["free"]);
  });

  it("treats a group as locked when the group itself is", () => {
    const layers = [group("g", [leaf("a", [0, 0, 5, 5])], { locked: true })];
    expect(draggableIds(layers, ["g"])).toEqual([]);
  });
});
