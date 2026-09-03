import { describe, it, expect } from "vitest";
import { decode } from "fast-png";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { runQuery } from "../src/queries.js";
import { findParentId } from "../src/model/tree.js";
import { memCas } from "./helpers/mem-cas.js";

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a; }
  return d;
}

const raster = (id: string, bounds: [number, number, number, number], rgba: number[]): Layer => ({
  id, type: "raster", name: id, bounds, opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false,
  pixels: { width: bounds[3] - bounds[1], height: bounds[2] - bounds[0], data: fill(bounds[3] - bounds[1], bounds[2] - bounds[0], rgba) },
});

function doc(): PsdDoc {
  return {
    canvas: { width: 2000, height: 2000, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [
      raster("bg", [0, 0, 2000, 2000], [0, 0, 0, 255]),
      {
        id: "g1", type: "group", name: "g1", bounds: [0, 0, 1200, 1600], opacity: 1, blendMode: "normal",
        visible: true, locked: false, clipping: false,
        children: [raster("portrait", [0, 0, 1200, 1600], [10, 20, 30, 255])],
      },
    ],
  };
}

describe("getLayerPixels", () => {
  it("给出原生分辨率的 PNG —— 不走 getPreview 的字节预算", async () => {
    const { ctx, nodes } = memCas();
    const r = await runQuery({ kind: "getLayerPixels", payload: { layerId: "portrait" } }, doc(), ctx) as any;
    expect(r.width).toBe(1600);
    expect(r.height).toBe(1200);
    const png = decode(nodes.get(r.image.hash)!);
    expect(png.width).toBe(1600); // getPreview 会把它压到 768
    expect(png.height).toBe(1200);
  });

  it("带出 bounds / parentId / index，effect 靠它把结果层插在源层正上方", async () => {
    const { ctx } = memCas();
    const r = await runQuery({ kind: "getLayerPixels", payload: { layerId: "portrait" } }, doc(), ctx) as any;
    expect(r.bounds).toEqual([0, 0, 1200, 1600]);
    expect(r.parentId).toBe("g1");
    expect(r.index).toBe(0);
  });

  it("根层的 parentId 是 null", async () => {
    const { ctx } = memCas();
    const r = await runQuery({ kind: "getLayerPixels", payload: { layerId: "bg" } }, doc(), ctx) as any;
    expect(r.parentId).toBeNull();
    expect(r.index).toBe(0);
  });

  it("给了 maxPixels 就按预算缩小编码，但 bounds 仍是图层的真实位置", async () => {
    const ctx = memCas();
    const budget = 200 * 200; // 远小于 1600x1200
    const r = await runQuery(
      { kind: "getLayerPixels", payload: { layerId: "portrait", maxPixels: budget } },
      doc(), ctx.ctx,
    ) as any;
    // 返回的图被缩过
    expect(r.width * r.height).toBeLessThanOrEqual(budget);
    expect(r.width).toBeLessThan(1600);
    // 真正落盘的 PNG 也确实是缩小后的，不是"报了个小尺寸、编了张大图"
    const png = decode(ctx.nodes.get(r.image.hash)!);
    expect([png.width, png.height]).toEqual([r.width, r.height]);
    // bounds 不动 —— 调用方靠它把结果缩回原位
    expect(r.bounds).toEqual([0, 0, 1200, 1600]);
  });

  it("图层本来就在预算内时一个像素都不缩", async () => {
    const ctx = memCas();
    const r = await runQuery(
      { kind: "getLayerPixels", payload: { layerId: "portrait", maxPixels: 100_000_000 } },
      doc(), ctx.ctx,
    ) as any;
    expect([r.width, r.height]).toEqual([1600, 1200]);
  });

  it("图层不存在时报出图层 id", async () => {
    const { ctx } = memCas();
    await expect(runQuery({ kind: "getLayerPixels", payload: { layerId: "nope" } }, doc(), ctx))
      .rejects.toThrow(/nope/);
  });

  it("超过像素上限直接拒绝，不 OOM —— 且拦截确实发生在渲染之前", async () => {
    const d = doc();
    // bounds 撑到 5000x5000 (25M px > MAX_EDIT_SOURCE_PIXELS)，但换成一个
    // 懒 PixelRef，且它的 hash 故意不存在于这次的 CAS store 里，宽高也很小
    // （不真的分配 5000x5000 的 RGBA，那是 100 MB）。
    //
    // 这个 hash-缺失的设计是为了让测试真正分辨守卫的先后顺序，而不只是
    // 断言同一个错误信息：
    //   - 守卫在 renderLayer 之前（当前实现）：从 bounds 算出的像素数超限，
    //     直接抛 /too large/，从不触碰这个不存在的 hash。
    //   - 若守卫被挪到 renderLayer 之后：renderLayer 会先尝试解析这个
    //     PixelRef，因 hash 在 store 里找不到而抛出完全不同的错误
    //     （blob/CAS not found），/too large/ 的断言就会失败。
    // 这一点是验证过的，不是推理出来的：把守卫临时挪到 renderLayer 之后
    // 重跑，本用例的失败信息从 /too large/ 变成 CAS 里找不到
    // "0000…0000" 这个 hash —— 断言确实抓住了顺序，而不是碰巧同名。
    d.layers[0] = {
      ...d.layers[0],
      bounds: [0, 0, 5000, 5000],
      pixels: { width: 4, height: 4, hash: "0".repeat(64) },
    };
    d.canvas = { ...d.canvas, width: 5000, height: 5000 };
    const { ctx } = memCas();
    await expect(runQuery({ kind: "getLayerPixels", payload: { layerId: "bg" } }, d, ctx))
      .rejects.toThrow(/too large/i);
  });
});

describe("findParentId", () => {
  it("嵌套层返回它所在组的 id", () => {
    expect(findParentId(doc().layers, "portrait")).toBe("g1");
  });
  it("根层返回 null", () => {
    expect(findParentId(doc().layers, "bg")).toBeNull();
  });
  it("找不到时也返回 null", () => {
    expect(findParentId(doc().layers, "nope")).toBeNull();
  });
});
