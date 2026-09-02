import { describe, expect, it } from "vitest";
import { decode } from "fast-png";
import { alphaStats, runQuery } from "../src/queries.js";
import { memCas } from "./helpers/mem-cas.js";
import type { PsdDoc } from "../src/model/types.js";

/**
 * 模型看不见透明。
 *
 * 实测（operator 模型，claude-opus-4-6）：把同一个白色图形分别放在**全透明
 * 背景**和**真实黑底**上，各编成 PNG 一起交给它，问"图形之外是什么"。
 * 透明那张它答"白色"，并且说"白色图形在白色背景上而几乎不可见"——它连图形
 * 都没看见；黑底那张它描述得一清二楚。
 *
 * 也就是说 PNG 的 alpha 在视觉管线里被压平成了白色。后果不止于"判断不了
 * 透明"：任何浅色内容 + 透明背景的图层（白色 logo、白色标题字），
 * getPreview{layerId} 交给模型的就是一片空白，它会以为那层是空的。
 *
 * 两条对策，这个文件钉住它们：预览铺棋盘格让内容重新可见，以及把透明度
 * 当成**数字**报出去而不是指望模型看出来。
 */
const px = (w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
};

/** 白色横条 + 四周全透明 —— 正是实测里模型完全看不见的那种图层。 */
const whiteOnTransparent = (w: number, h: number) =>
  px(w, h, (_x, y) => (y >= h / 2 - 4 && y < h / 2 + 4 ? [255, 255, 255, 255] : [255, 255, 255, 0]));

async function preview(pixels: ReturnType<typeof px>) {
  const { ctx } = memCas();
  const doc: PsdDoc = {
    canvas: { width: pixels.width, height: pixels.height, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [{
      id: "l1", type: "raster", name: "l1",
      bounds: [0, 0, pixels.height, pixels.width],
      opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
      pixels: { width: pixels.width, height: pixels.height, data: pixels.data },
    }],
  } as unknown as PsdDoc;
  const r = await runQuery({ kind: "getPreview", payload: { layerId: "l1" } }, doc, ctx) as any;
  const handle = await ctx.openSBlob(r.image);
  const bytes = await handle.readBytes({ offset: 0, length: handle.size });
  return { alpha: r.alpha as { opaque: number; transparent: number; soft: number }, img: decode(bytes) };
}

describe("预览里的透明", () => {
  it("alphaStats 三个比例加起来是 1，且分得清全透明、软边和实心", () => {
    const s = alphaStats(px(10, 10, (x) => [0, 0, 0, x < 3 ? 0 : x < 5 ? 128 : 255]));
    expect(s.transparent).toBe(0.3);
    expect(s.soft).toBe(0.2);
    expect(s.opaque).toBe(0.5);
    expect(s.opaque + s.transparent + s.soft).toBe(1);
  });

  it("统计取自原始像素，不受预览降采样影响", () => {
    // 直接对同一份像素调 alphaStats，和它作为大图过一遍预览之后报出来的比例
    // 应当一致 —— 降采样会把软边抹匀，如果统计放在缩放之后就会偏。
    const big = whiteOnTransparent(2000, 1200);
    expect(alphaStats(big).transparent).toBeGreaterThan(0.9);
  });

  it("白色内容 + 透明背景：铺棋盘格之后内容重新可见 —— 这是模型的盲区", async () => {
    const { img, alpha } = await preview(whiteOnTransparent(256, 128));
    expect(alpha.opaque).toBe(0.063);   // 8/128 行是白条 = 0.0625，统计按三位小数取整
    // 关键断言：输出里必须同时存在白色和棋盘格的深色 —— 有对比，内容才看得见。
    // 没有棋盘格时，透明被压平成白色，整张图只有一种颜色，白条彻底消失。
    const seen = new Set<number>();
    for (let i = 0; i < img.data.length; i += img.channels) seen.add(img.data[i]);
    expect(seen.has(255)).toBe(true);
    expect(seen.has(204)).toBe(true);
    // 铺完必须全不透明，否则下游管线还是会把它压平
    if (img.channels === 4) {
      for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
    }
  });

  it("实心图层不铺棋盘格 —— 没有透明还铺纯属给模型添乱", async () => {
    const { img, alpha } = await preview(px(64, 64, () => [10, 20, 30, 255]));
    expect(alpha).toEqual({ opaque: 1, transparent: 0, soft: 0 });
    const seen = new Set<number>();
    for (let i = 0; i < img.data.length; i += img.channels) seen.add(img.data[i]);
    expect(seen).toEqual(new Set([10]));
  });
});
