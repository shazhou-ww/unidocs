import { describe, expect, it } from "vitest";
import { layoutText, SMALL_CAPS_RATIO } from "../src/text/layout.js";
import { fakeFace } from "./text-fake-face.js";

describe("layoutText", () => {
  it("逐字形累加步进宽度", () => {
    // 每个字形宽 1000 font units，em=1000 → 字号即步进
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "ab", style: { size: 10 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.x)).toEqual([0, 10]);
  });

  it("字偶距生效：负 kerning 把第二个字形拉近确切的像素数", () => {
    // "a"(97) "b"(98) 一对 -100 font units 的 kerning，字号 10、em 1000。
    // 纯 advance 会落在 x=10；kerning 再把它拉回 -100/1000*10 = -1px → x=9。
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000, kerning: { "97:98": -100 } });
    const out = layoutText({ content: "ab", style: { size: 10 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.x)).toEqual([0, 9]);
  });

  it("跨字体不加字偶距：即便两套字体各自都有这对码位的 kerning 条目", () => {
    // faceA、faceB 都给 (97,98) 配了很大的负 kerning——如果实现漏掉了“必须
    // 同一套字体”这条判断，无论查哪张表结果都会偏离纯 advance。正确实现应该
    // 完全跳过 kerning 查表，第二个字形落在纯 advance 的位置上。
    const faceA = fakeFace({ advance: 1000, unitsPerEm: 1000, kerning: { "97:98": -500 } });
    const faceB = fakeFace({ advance: 1000, unitsPerEm: 1000, kerning: { "97:98": -300 } });
    const out = layoutText(
      { content: "ab", style: { size: 10 } },
      cp => (cp === 97 ? faceA : faceB),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.x)).toEqual([0, 10]);
    expect(out.glyphs[0].face).toBe(faceA);
    expect(out.glyphs[1].face).toBe(faceB);
  });

  it("tracking 200/1000 em 在 58px 下每个字形多推 11.6px", () => {
    // advance 设为 0，把步进宽度的贡献清零，这样位移只可能来自 tracking。
    const face = fakeFace({ advance: 0, unitsPerEm: 1000 });
    const out = layoutText(
      { content: "abc", style: { size: 58, tracking: 200 } },
      () => face,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const xs = out.glyphs.map(g => g.x);
    expect(xs[0]).toBeCloseTo(0, 6);
    expect(xs[1]).toBeCloseTo(11.6, 6);
    expect(xs[2]).toBeCloseTo(23.2, 6);
  });

  it('caps: "all" 把 "ab" 排成 A/B 两个字形', () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "ab", style: { size: 10, caps: "all" } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs).toHaveLength(2);
    expect(out.glyphs.map(g => g.codePoint)).toEqual(["A".codePointAt(0), "B".codePointAt(0)]);
  });

  it('caps: "small" 只缩本来是小写的字符：本来就大写的维持原字号', () => {
    // "Ab"：A 本来就是大写，toUpperCase() 前后不变，维持 baseSize；
    // b 本来是小写，被真的转换过，按 SMALL_CAPS_RATIO 缩。
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "Ab", style: { size: 10, caps: "small" } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.codePoint)).toEqual(["A".codePointAt(0), "B".codePointAt(0)]);
    expect(out.glyphs[0].size).toBe(10); // A：本来就是大写，不缩
    expect(out.glyphs[1].size).toBeCloseTo(10 * SMALL_CAPS_RATIO, 6); // b：本来是小写，缩
    expect(SMALL_CAPS_RATIO).toBe(0.7);
  });

  it('caps: "all" 不受“本来是不是小写”影响，恒定用原字号', () => {
    // 反向验证：C2 的判据只应该影响 "small"，不该连带改了 "all" 的行为。
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "Ab", style: { size: 10, caps: "all" } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.size)).toEqual([10, 10]);
  });

  it("手工 kerning：autoKerning:false 时按 kerning/1000*size 推进，与 tracking 同单位", () => {
    // advance 清零，隔离掉步进宽度的贡献，位移只可能来自手工 kerning。
    const face = fakeFace({ advance: 0, unitsPerEm: 1000 });
    const out = layoutText(
      {
        content: "ab",
        runs: [
          { length: 1, style: { size: 10 } },
          { length: 1, style: { size: 10, autoKerning: false, kerning: 200 } },
        ],
      },
      () => face,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.x)).toEqual([0, (200 / 1000) * 10]);
  });

  it("autoKerning 默认（未显式设置）时手工 kerning 不生效", () => {
    // 同样的 kerning:200、advance 清零，但没有 autoKerning:false——手工值
    // 必须被忽略，第二个字形应该落在 x=0（纯 advance，因为 advance 本身是 0）。
    const face = fakeFace({ advance: 0, unitsPerEm: 1000 });
    const out = layoutText(
      {
        content: "ab",
        runs: [
          { length: 1, style: { size: 10 } },
          { length: 1, style: { size: 10, kerning: 200 } },
        ],
      },
      () => face,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.x)).toEqual([0, 0]);
  });

  it("手工 kerning 跨字体也生效——它是作者指定的偏移，和字形来自哪套字体无关", () => {
    // faceA、faceB 各自的 kerning 表都留空（0），如果手工值被“同字体”这条
    // 规则误伤，位移会变回纯 advance（0），和预期的 5px 不一致。
    const faceA = fakeFace({ advance: 0, unitsPerEm: 1000 });
    const faceB = fakeFace({ advance: 0, unitsPerEm: 1000 });
    const out = layoutText(
      {
        content: "ab",
        runs: [
          { length: 1, style: { size: 10 } },
          { length: 1, style: { size: 10, autoKerning: false, kerning: 500 } },
        ],
      },
      cp => (cp === "a".codePointAt(0) ? faceA : faceB),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs[0].face).toBe(faceA);
    expect(out.glyphs[1].face).toBe(faceB);
    expect(out.glyphs.map(g => g.x)).toEqual([0, (500 / 1000) * 10]);
  });

  it("三种 justification 的 x 偏移：同一串文本首字形分别是 0 / -w/2 / -w", () => {
    // "abc"，每个字形宽 10px，总宽 30px。
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const layout = (justification: "left" | "right" | "center") =>
      layoutText(
        { content: "abc", style: { size: 10 }, paragraphStyle: { justification } },
        () => face,
      );

    const left = layout("left");
    const right = layout("right");
    const center = layout("center");
    expect(left.ok && right.ok && center.ok).toBe(true);
    if (!left.ok || !right.ok || !center.ok) return;
    expect(left.glyphs[0].x).toBe(0);
    expect(right.glyphs[0].x).toBe(-30);
    expect(center.glyphs[0].x).toBe(-15);
  });

  it("多行按 leading 递增 y；缺省 leading 用 size * 1.2", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "a\nb\nc", style: { size: 10 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 换行符本身不产生字形，三行各一个字形。
    expect(out.glyphs).toHaveLength(3);
    expect(out.glyphs.map(g => g.y)).toEqual([0, 12, 24]);
  });

  it("显式 leading 覆盖默认的 size * 1.2", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "a\nb\nc", style: { size: 10, leading: 20 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.y)).toEqual([0, 20, 40]);
  });

  it("baselineShift 直接加到该字形的 y 上", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "a", style: { size: 10, baselineShift: 5 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs[0].y).toBe(5);
  });

  it("逐字符回退：中英混排时英文字形来自 face A、中文来自 face B", () => {
    const faceA = fakeFace({ postScriptName: "Latin", advance: 1000, unitsPerEm: 1000 });
    const faceB = fakeFace({ postScriptName: "CJK", advance: 1000, unitsPerEm: 1000 });
    const out = layoutText(
      { content: "A中", style: { size: 10 } },
      cp => (cp < 128 ? faceA : faceB),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs[0].face).toBe(faceA);
    expect(out.glyphs[1].face).toBe(faceB);
  });

  it("缺字进 missing 且不产生字形", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText(
      { content: "ab", style: { size: 10 } },
      cp => (cp === "b".codePointAt(0) ? null : face),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs).toHaveLength(1);
    expect(out.glyphs[0].codePoint).toBe("a".codePointAt(0));
    expect(out.missing).toEqual(["b".codePointAt(0)]);
  });

  it("boxBounds 存在 → ok: false", () => {
    const face = fakeFace();
    const out = layoutText(
      { content: "ab", style: { size: 10 }, boxBounds: [0, 0, 100, 100] },
      () => face,
    );
    expect(out.ok).toBe(false);
  });

  it('orientation: "vertical" → ok: false', () => {
    const face = fakeFace();
    const out = layoutText(
      { content: "ab", style: { size: 10 }, orientation: "vertical" },
      () => face,
    );
    expect(out.ok).toBe(false);
  });

  it("uneditable 非空 → ok: false", () => {
    const face = fakeFace();
    const out = layoutText(
      { content: "ab", style: { size: 10 }, uneditable: ["warp"] },
      () => face,
    );
    expect(out.ok).toBe(false);
  });

  it("orientation: horizontal（或缺省）不拒绝——只有 vertical 才拒绝", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText(
      { content: "a", style: { size: 10 }, orientation: "horizontal" },
      () => face,
    );
    expect(out.ok).toBe(true);
  });

  it("underline: true → ignored 含 underline，但字形照常产出", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "ab", style: { size: 10, underline: true } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ignored).toEqual(["underline"]);
    expect(out.glyphs).toHaveLength(2);
  });

  it("六种忽略样式全部命中时都进 ignored，且跨 run 去重", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const ignoredStyle = {
      size: 10,
      underline: true,
      strikethrough: true,
      strokeColor: { r: 255, g: 0, b: 0 },
      fauxBold: true,
      fauxItalic: true,
      ligatures: true,
    };
    const out = layoutText(
      {
        content: "ab",
        runs: [
          { length: 1, style: ignoredStyle },
          { length: 1, style: ignoredStyle }, // 两个 run 都命中同一批 flag，不应该重复出现
        ],
      },
      () => face,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([...out.ignored].sort()).toEqual(
      ["underline", "strikethrough", "strokeColor", "fauxBold", "fauxItalic", "ligatures"].sort(),
    );
  });

  it("没有命中任何忽略样式时 ignored 是空数组", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "ab", style: { size: 10 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ignored).toEqual([]);
  });

  it("runs[] 逐段样式：第二段的颜色和字距各自生效", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText(
      {
        content: "ab",
        runs: [
          { length: 1, style: { size: 10, color: { r: 0, g: 0, b: 0 } } },
          { length: 1, style: { size: 10, color: { r: 255, g: 0, b: 0 }, tracking: 500 } },
        ],
      },
      () => face,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs[0].color).toEqual({ r: 0, g: 0, b: 0 });
    expect(out.glyphs[1].color).toEqual({ r: 255, g: 0, b: 0 });
    // 第二个字形之前应用了自己的 tracking，但 tracking 只影响“之后”的推进，
    // 不影响它自己的落点——第二个字形的 x 还是纯 advance 处（10px）。
    expect(out.glyphs[1].x).toBe(10);
  });

  it("空文本：没有字形、ignored 为空、inkBounds 四个数都是 0", () => {
    const face = fakeFace();
    const out = layoutText({ content: "", style: { size: 10 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs).toEqual([]);
    expect(out.ignored).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.inkBounds).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it("inkBounds 由轮廓命令的锚点/控制点算出，y 轴从字体坐标系翻到文档坐标系", () => {
    // 假字体默认轮廓是一个占满 em 的矩形：字体坐标系里 (0,0)-(1000,1000)。
    // size=10、unitsPerEm=1000 → 每 font unit 对应 0.01px；y 轴上负下正，
    // 所以字形主体（原本在基线上方）映到 top=-10、bottom=0。
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "a", style: { size: 10 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.inkBounds).toEqual({ left: 0, top: -10, right: 10, bottom: 0 });
  });
});
