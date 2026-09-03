/**
 * `parseFontFace`/`fontCoverage`（`src/text/opentype-face.ts`）的测试。
 *
 * 用 `text-test-font.ts` 现造的字体（形状/度量都是我们自己指定的数字，不是
 * 猜的），不依赖系统字体、不提交第三方字体二进制——见该文件顶部注释。
 *
 * 最后一段是 brief Step 7 要求的端到端测试：把这里实现的 `parseFontFace`
 * 接进 Task 2 的 `layoutText` 和 Task 3 的 `rasterizeGlyphs`，验证三块拼起来
 * 之后的墨迹宽度可以被精确预测——这是三个任务接口对不对的唯一守门人。
 */
import { describe, expect, it } from "vitest";
import { fontCoverage, parseFontFace } from "../src/text/opentype-face.js";
import { layoutText } from "../src/text/layout.js";
import type { Pixels } from "../src/model/types.js";
import { rasterizeGlyphs } from "../src/text/raster.js";
import { fakeFace } from "./text-fake-face.js";
import { buildGaplessTestFont, buildSparseCoverageTestFont, buildTestFont } from "./text-test-font.js";

const cp = (ch: string): number => ch.codePointAt(0)!;

describe("parseFontFace: 度量", () => {
  it("从字体文件解析出的度量与构造时指定的一致", () => {
    const face = parseFontFace(buildTestFont());
    expect(face.unitsPerEm).toBe(1000);
    expect(face.advance(cp("A"))).toBe(600);
    expect(face.has(cp("A"))).toBe(true);
    expect(face.has(cp("中"))).toBe(false);
  });

  it("ascender/descender 与构造时指定的一致", () => {
    const face = parseFontFace(buildTestFont());
    expect(face.ascender).toBe(800);
    expect(face.descender).toBe(-200);
  });

  it("postScriptName 来自字体自己的名字表", () => {
    const face = parseFontFace(buildTestFont());
    // familyName "UnidocsTestFont" + styleName "Regular"，opentype.js 默认的
    // postScriptName 生成规则就是直接拼接（实测确认过，不是猜的）。
    expect(face.postScriptName).toBe("UnidocsTestFontRegular");
  });

  it("has 对两个字形和一个缺字码位分别给出正确结果，不是恒真", () => {
    const face = parseFontFace(buildTestFont());
    expect(face.has(cp("A"))).toBe(true);
    expect(face.has(cp("B"))).toBe(true);
    expect(face.has(cp("中"))).toBe(false);
    // 一个字体里完全不会出现的高码位，双重确认不是"只测了一个中文字符
    // 侥幸不在表里"。
    expect(face.has(0x1f600)).toBe(false);
  });

  it("advance 按字形分别读 advanceWidth，A/B 两个字形的值不同、不会串号", () => {
    const face = parseFontFace(buildTestFont());
    expect(face.advance(cp("A"))).toBe(600);
    expect(face.advance(cp("B"))).toBe(650);
  });

  it("outline 是字体坐标系（y 轴向上）里的矩形轮廓，与构造时的形状一致", () => {
    const face = parseFontFace(buildTestFont());
    expect(face.outline(cp("A"))).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 500, y: 0 },
      { type: "L", x: 500, y: 700 },
      { type: "L", x: 0, y: 700 },
      { type: "Z" },
    ]);
    expect(face.outline(cp("B"))).toEqual([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 300, y: 0 },
      { type: "L", x: 300, y: 400 },
      { type: "L", x: 0, y: 400 },
      { type: "Z" },
    ]);
  });

  it("kerning 在没有 kern/GPOS 表的字体上返回 0，不抛异常", () => {
    // opentype.js 2.0.0 的构造 API 没有暴露写 kern/GPOS 表的能力（只能解析
    // 已有字体里的，不能造），所以这里测不出非零字偶距——真正"字偶距生效"
    // 这件事是在定方案阶段用一份真实字体的探针验证过的（见 task-4 brief
    // 上文），这里只保证"没有字偶距表时不崩、老实返回 0"这条兜底路径。
    const face = parseFontFace(buildTestFont());
    expect(face.kerning(cp("A"), cp("B"))).toBe(0);
  });

  it("对缺字的码位调用 advance/outline，退回 .notdef 的度量而不是抛异常", () => {
    // layoutText 正常不会走到这里（缺字直接跳过，见 layout.ts），这里测的
    // 是"万一被直接调用"这条防御路径的具体行为——用我们自己造的字体，
    // .notdef 的 advanceWidth/outline 是已知的（0 / 空数组）。
    const face = parseFontFace(buildTestFont());
    const missing = cp("中");
    expect(() => face.advance(missing)).not.toThrow();
    expect(face.advance(missing)).toBe(0);
    expect(face.outline(missing)).toEqual([]);
  });

  it("缓存不改变可观察行为：同一个 face 反复调用 has/advance/outline，结果每次都一样", () => {
    const face = parseFontFace(buildTestFont());
    for (let i = 0; i < 3; i++) {
      expect(face.has(cp("A"))).toBe(true);
      expect(face.advance(cp("A"))).toBe(600);
      expect(face.advance(cp("B"))).toBe(650);
      expect(face.outline(cp("A"))).toEqual([
        { type: "M", x: 0, y: 0 },
        { type: "L", x: 500, y: 0 },
        { type: "L", x: 500, y: 700 },
        { type: "L", x: 0, y: 700 },
        { type: "Z" },
      ]);
    }
  });

  it("两个 parseFontFace 实例各自独立，互不污染缓存", () => {
    const faceA = parseFontFace(buildTestFont());
    const faceB = parseFontFace(buildGaplessTestFont());
    // faceA 的 "A" advance 是 600（500x700 矩形），faceB 的 "A" advance 也是
    // 600 但矩形是 600x700——用 outline 的差异确认两个实例没有共享缓存。
    expect(faceA.outline(cp("A"))[1]).toEqual({ type: "L", x: 500, y: 0 });
    expect(faceB.outline(cp("A"))[1]).toEqual({ type: "L", x: 600, y: 0 });
  });
});

describe("fontCoverage", () => {
  it("相邻码位合并成一个区间", () => {
    const face = parseFontFace(buildTestFont());
    // buildTestFont() 里 A=0x41=65，B=0x42=66，相邻。
    expect(fontCoverage(face)).toEqual([[65, 66]]);
  });

  it("不相邻的码位保持成两个独立区间，不会被错误合并", () => {
    const face = parseFontFace(buildSparseCoverageTestFont());
    // 'A' = 0x41 = 65，'中' = 0x4E2D = 20013，中间隔得很远。
    expect(fontCoverage(face)).toEqual([
      [65, 65],
      [20013, 20013],
    ]);
  });

  it("传一个不是这个模块产出的 face 会显式报错，而不是静默返回错的覆盖范围", () => {
    expect(() => fontCoverage(fakeFace())).toThrow();
  });
});

describe("端到端：parseFontFace 接入 layoutText + rasterizeGlyphs", () => {
  it("N 个字符排一行、栅格化后墨迹宽度精确等于 N × advance/unitsPerEm × size", () => {
    // buildGaplessTestFont()："A" 是 600x700 的矩形、advance 也是 600——
    // 矩形宽度恰好等于步进宽度，连续摆放时彼此首尾相接、中间不留缝，这样
    // "墨迹总宽度 == N × advance/unitsPerEm × size" 才能精确成立（不是近似）。
    // buildTestFont() 故意宽度≠advance，留了缝，这个等式在那套字体上不成立。
    const face = parseFontFace(buildGaplessTestFont());
    const size = 100;
    const charCount = 4;
    const text = "A".repeat(charCount);

    const laidOut = layoutText({ content: text, style: { size } }, () => face);
    expect(laidOut.ok).toBe(true);
    if (!laidOut.ok) return;
    expect(laidOut.glyphs).toHaveLength(charCount);
    expect(laidOut.missing).toEqual([]);

    const expectedInkWidth = (charCount * face.advance(cp("A")) * size) / face.unitsPerEm;
    expect(expectedInkWidth).toBe(240); // 4 * 600/1000 * 100，手算核对，不是循环论证

    // 排版本身（Task 2）算出来的 inkBounds 是纯几何换算，不经过栅格化——
    // 先在这一层核对一次公式。
    const { inkBounds } = laidOut;
    expect(inkBounds.right - inkBounds.left).toBe(expectedInkWidth);

    // 再经过栅格化（Task 3）验证像素层面的结果与几何层面一致：画布比墨迹
    // 包围盒各方向多留 10px 边距，这样"墨迹只出现在预期范围内、边距区域
    // 全空"和"墨迹宽度 == 公式算出的值"都能被独立测到，不是循环论证。
    const margin = 10;
    const origin = { x: inkBounds.left - margin, y: inkBounds.top - margin };
    const width = Math.round(inkBounds.right - inkBounds.left) + margin * 2;
    const height = Math.round(inkBounds.bottom - inkBounds.top) + margin * 2;
    const pixels = rasterizeGlyphs(laidOut.glyphs, width, height, origin);

    const range = paintedColumnRange(pixels);
    expect(range).not.toBeNull();
    if (!range) return;
    expect(range.max - range.min + 1).toBe(expectedInkWidth);
    // 边距列应该完全没有墨迹（不是"大致没有"，逐列检查）。
    expect(range.min).toBe(margin);
    expect(range.max).toBe(margin + expectedInkWidth - 1);

    // 矩形字形、整数对齐（size=100/unitsPerEm=1000 换算出的所有坐标都是
    // 整数），墨迹范围内每个像素应该是满覆盖（255），不该有抗锯齿造成的
    // 半透明像素——这条断言专门用来发现"坐标换算/取整"引入的偏移。
    for (let y = margin; y < margin + 70; y++) {
      for (let x = range.min; x <= range.max; x++) {
        expect(alphaAt(pixels, x, y)).toBe(255);
      }
    }
    // 上下边距（各 10px）应该全空。
    for (let y = 0; y < margin; y++) {
      for (let x = 0; x < width; x++) {
        expect(alphaAt(pixels, x, y)).toBe(0);
      }
    }
  });
});

function alphaAt(pixels: Pixels, x: number, y: number): number {
  const i = (y * pixels.width + x) * 4;
  return pixels.data[i + 3];
}

/** 扫描整张图,找出"至少有一行 alpha>0"的最左/最右列。没有任何墨迹时返回
 *  null。 */
function paintedColumnRange(pixels: Pixels): { min: number; max: number } | null {
  let min = -1;
  let max = -1;
  for (let x = 0; x < pixels.width; x++) {
    let painted = false;
    for (let y = 0; y < pixels.height; y++) {
      if (alphaAt(pixels, x, y) > 0) {
        painted = true;
        break;
      }
    }
    if (painted) {
      if (min === -1) min = x;
      max = x;
    }
  }
  return min === -1 ? null : { min, max };
}
