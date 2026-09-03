/**
 * `rasterizeGlyphs` 的测试：排版好的字形（`PlacedGlyph`）栅格化成 RGBA 像素。
 *
 * 用假字体（`fakeFace`）摆出一个已知形状的轮廓（矩形、"O" 形的环），这样
 * 覆盖率、抗锯齿、非零环绕这些断言都能核对到确切数值，不依赖真实字体解析
 * （那是 Task 4 的事）。
 */
import { describe, expect, it } from "vitest";
import { rasterizeGlyphs } from "../src/text/raster.js";
import type { PlacedGlyph } from "../src/text/layout.js";
import type { PathCommand } from "../src/text/font.js";
import { fakeFace } from "./text-fake-face.js";

/** 取像素 (x, y) 的 alpha 通道（0..255）。 */
function alphaAt(px: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number): number {
  const i = (y * px.width + x) * 4;
  return px.data[i + 3];
}

/** 取像素 (x, y) 的 RGB 三通道。 */
function rgbAt(
  px: { width: number; height: number; data: Uint8ClampedArray },
  x: number,
  y: number,
): [number, number, number] {
  const i = (y * px.width + x) * 4;
  return [px.data[i], px.data[i + 1], px.data[i + 2]];
}

/**
 * 摆一个矩形字形：轮廓在 unitsPerEm=1、size=1 的假字体坐标系里直接就是
 * [0,w] x [0,h]（font 坐标 y 向上），baseline 原点 `y` 设成 `docY + h`，这样
 * 换算成文档坐标（y 向下）之后矩形正好落在 [docX, docX+w] x [docY, docY+h]。
 * 见 raster.ts 里的换算公式与 layout.ts 的 computeInkBounds 保持同一口径。
 */
function rectGlyph(
  rect: { x: number; y: number; w: number; h: number },
  color: { r: number; g: number; b: number } = { r: 0, g: 0, b: 0 },
): PlacedGlyph {
  const face = fakeFace({
    unitsPerEm: 1,
    outline: () => [
      { type: "M", x: 0, y: 0 },
      { type: "L", x: rect.w, y: 0 },
      { type: "L", x: rect.w, y: rect.h },
      { type: "L", x: 0, y: rect.h },
      { type: "Z" },
    ],
  });
  return {
    codePoint: 0x41,
    face,
    x: rect.x,
    y: rect.y + rect.h,
    size: 1,
    horizontalScale: 1,
    verticalScale: 1,
    color,
  };
}

/**
 * 摆一个 "O" 形字形：外圈顺时针（+1 环绕），内圈逆时针（-1 环绕）——非零环绕
 * 规则下内圈区域会被外圈 + 内圈的环绕数抵消成 0，中心镂空。外圈
 * [0,outer]x[0,outer]，内圈居中 [gap, outer-gap]x[gap, outer-gap]。
 */
function ringGlyph(
  opts: { x: number; y: number; outer: number; gap: number },
  color: { r: number; g: number; b: number } = { r: 0, g: 0, b: 0 },
): PlacedGlyph {
  const { outer, gap } = opts;
  const inner = outer - gap;
  const commands: PathCommand[] = [
    // 外圈：顺时针
    { type: "M", x: 0, y: 0 },
    { type: "L", x: outer, y: 0 },
    { type: "L", x: outer, y: outer },
    { type: "L", x: 0, y: outer },
    { type: "Z" },
    // 内圈：逆时针（与外圈相反方向）
    { type: "M", x: gap, y: gap },
    { type: "L", x: gap, y: inner },
    { type: "L", x: inner, y: inner },
    { type: "L", x: inner, y: gap },
    { type: "Z" },
  ];
  const face = fakeFace({ unitsPerEm: 1, outline: () => commands });
  return {
    codePoint: 0x4f,
    face,
    x: opts.x,
    y: opts.y + outer,
    size: 1,
    horizontalScale: 1,
    verticalScale: 1,
    color,
  };
}

describe("rasterizeGlyphs", () => {
  it("整像素对齐的矩形字形：内部实心、外部全透明", () => {
    const glyph = rectGlyph({ x: 2, y: 2, w: 4, h: 4 });
    const px = rasterizeGlyphs([glyph], 8, 8, { x: 0, y: 0 });
    expect(alphaAt(px, 4, 4)).toBe(255);
    expect(alphaAt(px, 0, 0)).toBe(0);
    // 矩形四角之外的邻近像素也应该是全透明——不是只测了原点这一个点。
    expect(alphaAt(px, 6, 6)).toBe(0);
    expect(alphaAt(px, 1, 4)).toBe(0);
  });

  it("空字形列表：全透明画布", () => {
    const px = rasterizeGlyphs([], 4, 4, { x: 0, y: 0 });
    expect(px.width).toBe(4);
    expect(px.height).toBe(4);
    expect(px.data.length).toBe(4 * 4 * 4);
    for (let i = 0; i < px.data.length; i++) expect(px.data[i]).toBe(0);
  });

  it("半像素偏移的矩形：边缘那一列 alpha 约为 128（±8）——抗锯齿是真的在算覆盖率", () => {
    // 矩形从 x=2.5 到 x=6.5：像素列 2 只被覆盖右半（0.5），列 6 只被覆盖左半
    // （0.5）。垂直方向整数对齐，避免子扫描线量化把这条断言弄脏。
    const glyph = rectGlyph({ x: 2.5, y: 2, w: 4, h: 4 });
    const px = rasterizeGlyphs([glyph], 8, 8, { x: 0, y: 0 });
    expect(alphaAt(px, 2, 4)).toBeGreaterThanOrEqual(120);
    expect(alphaAt(px, 2, 4)).toBeLessThanOrEqual(136);
    expect(alphaAt(px, 6, 4)).toBeGreaterThanOrEqual(120);
    expect(alphaAt(px, 6, 4)).toBeLessThanOrEqual(136);
    // 完全在矩形内部的列还是要满覆盖，说明只有边缘是半透明。
    expect(alphaAt(px, 4, 4)).toBe(255);
  });

  it("非零环绕：带反向内圈的字形（O）中心必须透明，外圈实心", () => {
    const glyph = ringGlyph({ x: 0, y: 0, outer: 10, gap: 3 });
    const px = rasterizeGlyphs([glyph], 10, 10, { x: 0, y: 0 });
    // 中心（内圈内部）：透明。
    expect(alphaAt(px, 5, 5)).toBe(0);
    // 环带（外圈与内圈之间）：实心。
    expect(alphaAt(px, 1, 5)).toBe(255);
    expect(alphaAt(px, 5, 1)).toBe(255);
  });

  it("非零环绕（区别于 even-odd）：同向重叠的两个子路径，重叠区仍是实心，不是镂空", () => {
    // 反向内圈的 O 形（上一条用例）不足以证明用的是非零环绕而不是
    // even-odd——单个洞在两条规则下结果碰巧一样（嵌套边界，even-odd 天然
    // 也会把洞挖对）。真正能把两条规则分开的是"同一方向的两个轮廓子路径
    // 互相重叠"：nonzero 下重叠区域环绕数变成 2（≠0，继续填）；even-odd 下
    // 重叠区域被两次穿越抵消成"偶数=外部"，会被错误地抠空。
    //
    // 两个矩形子路径用完全相同的点序（同一个方向），只是位置不同、互相
    // 重叠：A 是 font 坐标 [0,6]x[0,6]，B 是 [3,9]x[3,9]。
    const commands: PathCommand[] = [
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 6, y: 0 },
      { type: "L", x: 6, y: 6 },
      { type: "L", x: 0, y: 6 },
      { type: "Z" },
      { type: "M", x: 3, y: 3 },
      { type: "L", x: 9, y: 3 },
      { type: "L", x: 9, y: 9 },
      { type: "L", x: 3, y: 9 },
      { type: "Z" },
    ];
    const face = fakeFace({ unitsPerEm: 1, outline: () => commands });
    const glyph: PlacedGlyph = {
      codePoint: 0x58,
      face,
      x: 0,
      y: 9,
      size: 1,
      horizontalScale: 1,
      verticalScale: 1,
      color: { r: 0, g: 0, b: 0 },
    };
    const px = rasterizeGlyphs([glyph], 10, 10, { x: 0, y: 0 });
    // 换算：ty(fy) = 9 - fy。A 覆盖画布 x∈[0,6] y∈[3,9]；B 覆盖 x∈[3,9]
    // y∈[0,6]；重叠区 x∈[3,6] y∈[3,6]。
    expect(alphaAt(px, 4, 4)).toBe(255); // 重叠区：nonzero 下必须仍是实心
    expect(alphaAt(px, 1, 7)).toBe(255); // 只在 A 内
    expect(alphaAt(px, 7, 1)).toBe(255); // 只在 B 内
    expect(alphaAt(px, 8, 8)).toBe(0); // A、B 都不覆盖
  });

  it("两个字形重叠：按 alpha 合成，不是直接覆盖", () => {
    // 半透明红（alpha 128）盖在不透明蓝上：结果应该是介于两者之间的混合色，
    // 且仍然保持不透明——如果实现是直接覆盖（后画的整个替换先画的），蓝色
    // 通道会被完全冲掉，看不到底色。
    const bottomColor = { r: 0, g: 0, b: 200 };
    const topColor = { r: 200, g: 0, b: 0 };
    const bottom = rectGlyph({ x: 0, y: 0, w: 6, h: 6 }, bottomColor);
    // 用一个 unitsPerEm 更大、size 更小的字体让顶层矩形半透明？—— 栅格化本身
    // 不支持字形级 alpha（PlacedGlyph 没有 alpha 字段），改用完全覆盖 +
    // 部分覆盖（次像素边缘）来验证合成而不是覆盖：顶层矩形往右下偏移半像素，
    // 使左上角落在半覆盖的边缘上，那个像素的颜色必须是两色的加权混合。
    const top = rectGlyph({ x: 0.5, y: 0.5, w: 6, h: 6 }, topColor);
    const px = rasterizeGlyphs([bottom, top], 8, 8, { x: 0, y: 0 });
    // 像素 (0,0)：只被 bottom 覆盖（顶层矩形从 0.5 开始，覆盖率 0.25 的角）。
    // 像素 (3,3)：两个矩形都满覆盖，最终颜色应该等于顶层颜色（完全不透明的
    // 顶层完全盖住底层）。
    const full = rgbAt(px, 3, 3);
    expect(full[0]).toBe(topColor.r);
    expect(full[1]).toBe(topColor.g);
    expect(full[2]).toBe(topColor.b);
    expect(alphaAt(px, 3, 3)).toBe(255);
    // 像素 (0,0)：只有 bottom 的部分覆盖（左上角落在 top 矩形之外），颜色应
    // 该偏向 bottomColor，且不是纯底色（说明确实按 alpha 而非整像素二值覆盖）
    // —— 这里主要断言它不是透明、也不是纯 topColor。
    const corner = rgbAt(px, 0, 0);
    expect(alphaAt(px, 0, 0)).toBeGreaterThan(0);
    expect(corner[2]).toBeGreaterThan(0); // 有 bottom 的蓝色分量参与
  });

  it("颜色来自 PlacedGlyph.color：同一次调用里不同字形可以不同色", () => {
    const red = rectGlyph({ x: 0, y: 0, w: 2, h: 2 }, { r: 255, g: 0, b: 0 });
    const green = rectGlyph({ x: 4, y: 4, w: 2, h: 2 }, { r: 0, g: 255, b: 0 });
    const px = rasterizeGlyphs([red, green], 8, 8, { x: 0, y: 0 });
    expect(rgbAt(px, 1, 1)).toEqual([255, 0, 0]);
    expect(rgbAt(px, 5, 5)).toEqual([0, 255, 0]);
    expect(alphaAt(px, 1, 1)).toBe(255);
    expect(alphaAt(px, 5, 5)).toBe(255);
  });

  it("完全在画布外的字形：不影响结果、也不越界写", () => {
    const offscreenLeft = rectGlyph({ x: -100, y: 2, w: 4, h: 4 });
    const offscreenBelow = rectGlyph({ x: 2, y: 1000, w: 4, h: 4 });
    const offscreenRight = rectGlyph({ x: 1000, y: 2, w: 4, h: 4 });
    const onscreen = rectGlyph({ x: 2, y: 2, w: 4, h: 4 }, { r: 10, g: 20, b: 30 });
    expect(() =>
      rasterizeGlyphs([offscreenLeft, offscreenBelow, offscreenRight, onscreen], 8, 8, { x: 0, y: 0 }),
    ).not.toThrow();
    const px = rasterizeGlyphs(
      [offscreenLeft, offscreenBelow, offscreenRight, onscreen],
      8,
      8,
      { x: 0, y: 0 },
    );
    // 结果应该和只画 onscreen 一样。
    const expected = rasterizeGlyphs([onscreen], 8, 8, { x: 0, y: 0 });
    expect(px.data).toEqual(expected.data);
  });

  it("部分在画布外的字形：可见的那部分照常栅格化", () => {
    // 矩形横跨画布右下边界：font/doc 坐标 [6,10]x[6,10]，画布只有 8x8，
    // 可见部分是 [6,8]x[6,8]。用来确认包围盒裁剪只挡完全在外的字形，不会
    // 连带裁掉部分可见的字形。
    const glyph = rectGlyph({ x: 6, y: 6, w: 4, h: 4 }, { r: 9, g: 8, b: 7 });
    const px = rasterizeGlyphs([glyph], 8, 8, { x: 0, y: 0 });
    expect(alphaAt(px, 7, 7)).toBe(255);
    expect(rgbAt(px, 7, 7)).toEqual([9, 8, 7]);
  });

  it("origin 平移：整体减去 origin 之后再落到画布上", () => {
    const glyph = rectGlyph({ x: 2, y: 2, w: 4, h: 4 });
    // origin (2,2) 相当于把画布原点挪到矩形左上角——矩形应该落在 [0,4]x[0,4]。
    const px = rasterizeGlyphs([glyph], 8, 8, { x: 2, y: 2 });
    expect(alphaAt(px, 2, 2)).toBe(255);
    expect(alphaAt(px, 5, 5)).toBe(0);
  });
});
