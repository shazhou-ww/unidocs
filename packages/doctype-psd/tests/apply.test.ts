import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { apply, applyOne } from "../src/ops/index.js";

const leaf = (id: string): Layer => ({ id, type: "raster", name: id, bounds: [0,0,1,1], opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false, pixels: { width: 1, height: 1, data: new Uint8ClampedArray(4) } });
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

  // 服务端拿到的 op payload 一定是冻结的:svalue-codec 的解码路径对每个解出来
  // 的对象都 Object.freeze(svalue.ts:386)。单测里构造的是普通对象,所以这条
  // 路径此前从未被覆盖 —— 线上 psd 的每一次 add_layer 都以
  // "Cannot add property opacity, object is not extensible" 失败。
  it("add_layer accepts a frozen payload and fills in the omitted defaults", () => {
    const bare = Object.freeze({
      id: "b", type: "raster", name: "b", bounds: Object.freeze([0, 0, 1, 1]),
      pixels: Object.freeze({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
    }) as unknown as Layer;

    const d2 = applyOne(doc(), { kind: "add_layer", payload: { layer: bare, parentId: null } });

    const added = d2.layers.find(l => l.id === "b")!;
    expect(added.opacity).toBe(1);
    expect(added.visible).toBe(true);
    expect(added.blendMode).toBe("normal");
    // 归一化必须落在副本上,调用方传进来的对象不许被改
    expect((bare as Partial<Layer>).opacity).toBeUndefined();
  });

  it("add_layer normalizes frozen group children too", () => {
    const group = Object.freeze({
      id: "g", type: "group", name: "g", bounds: Object.freeze([0, 0, 1, 1]),
      children: Object.freeze([Object.freeze({
        id: "c", type: "raster", name: "c", bounds: Object.freeze([0, 0, 1, 1]),
        pixels: Object.freeze({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
      })]),
    }) as unknown as Layer;

    const d2 = applyOne(doc(), { kind: "add_layer", payload: { layer: group, parentId: null } });
    const child = d2.layers.find(l => l.id === "g")!.children![0]!;
    expect(child.opacity).toBe(1);
    expect(child.visible).toBe(true);
    expect(child.blendMode).toBe("normal");
  });

  it("unknown kind throws", () => {
    expect(() => applyOne(doc(), { kind: "nope", payload: {} })).toThrow(/unknown op/);
  });
});
