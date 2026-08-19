import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { apply, applyOne } from "../src/ops/index.js";

const leaf = (id: string): Layer => ({ id, type: "raster", name: id, bounds: [0,0,1,1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false });
const doc = (): PsdDoc => ({ canvas: { width: 10, height: 10, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [leaf("a")] });

describe("apply", () => {
  it("applyOne does not mutate the input doc (pure)", () => {
    const d = doc();
    const d2 = applyOne(d, { kind: "add_layer", payload: { layer: leaf("b"), parentId: null } });
    expect(d.layers.map(l => l.id)).toEqual(["a"]);       // input unchanged
    expect(d2.layers.map(l => l.id)).toEqual(["a", "b"]); // output has new layer
  });

  it("apply folds a batch and is deterministic on replay", async () => {
    const ops = [
      { kind: "add_layer", payload: { layer: leaf("b"), parentId: null } },
      { kind: "set_props", payload: { layerId: "b", props: { opacity: 0.3 } } },
    ];
    const r1 = await apply(ops, doc());
    const r2 = await apply(ops, doc());
    expect(JSON.stringify(r1.layers)).toBe(JSON.stringify(r2.layers));
    expect(r1.layers.find(l => l.id === "b")!.opacity).toBe(0.3);
  });

  it("unknown kind throws", () => {
    expect(() => applyOne(doc(), { kind: "nope", payload: {} })).toThrow(/unknown op/);
  });
});
