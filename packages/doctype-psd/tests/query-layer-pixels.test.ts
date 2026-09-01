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

  it("图层不存在时报出图层 id", async () => {
    const { ctx } = memCas();
    await expect(runQuery({ kind: "getLayerPixels", payload: { layerId: "nope" } }, doc(), ctx))
      .rejects.toThrow(/nope/);
  });

  it("超过像素上限直接拒绝，不 OOM", async () => {
    const d = doc();
    // 只把 bounds 撑大，不真的分配 5000x5000 的 RGBA（那是 100 MB）。
    // 上限检查读的就是 bounds，在 renderLayer 之前就该拦下来 —— 这个
    // 测试同时钉住了"拦截发生在分配之前"这件事。
    d.layers[0] = { ...d.layers[0], bounds: [0, 0, 5000, 5000] };
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
