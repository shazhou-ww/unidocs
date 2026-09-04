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

  // 真实 PSD 的形状:字号/字体/caps 只写在层级 style 上,styleRuns 只存增量
  // (颜色、tracking)。合成 fixture 里每个 run 都把样式写全了,所以"继承"这件
  // 事在其余用例里完全测不到 —— 而漏掉它的后果是真实文件上字号掉回
  // DEFAULT_FONT_SIZE(12px),58px 的标题排成六分之一大。
  it("逐段样式叠在层级样式之上：run 只给颜色时，字号仍来自层级 style", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({
      content: "ab",
      style: { size: 58, font: "LayerFont" },
      runs: [
        { length: 1, style: { color: { r: 1, g: 2, b: 3 } } },
        { length: 1, style: { color: { r: 4, g: 5, b: 6 } } },
      ],
    }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 继承到了 size:58 → 步进 58px;丢了就是 DEFAULT_FONT_SIZE 的 12px。
    expect(out.glyphs.map(g => g.x)).toEqual([0, 58]);
    expect(out.glyphs.map(g => g.size)).toEqual([58, 58]);
    // run 自己给的颜色照常压过层级。
    expect(out.glyphs.map(g => g.color)).toEqual([{ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }]);
  });

  it("请求的字体也走继承：run 没写 font 时按层级 style 的字体去要", () => {
    const asked: (string | undefined)[] = [];
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    layoutText({
      content: "ab",
      style: { size: 10, font: "LayerFont" },
      runs: [{ length: 2, style: { color: { r: 0, g: 0, b: 0 } } }],
    }, (_cp, requested) => { asked.push(requested); return face; });
    expect(asked).toEqual(["LayerFont", "LayerFont"]);
  });

  it("run 显式给的字段压过层级，但显式 undefined 不抹掉继承来的值", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({
      content: "ab",
      style: { size: 58 },
      runs: [
        { length: 1, style: { size: 10 } },
        { length: 1, style: { size: undefined } },
      ],
    }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.size)).toEqual([10, 58]);
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

  // 方向而不只是数值：正的 baselineShift 让字形**视觉向上**（跨标准一致 ——
  // CSS baseline-shift / PDF 的 Ts / PostScript / Photoshop 面板都是正值抬升），
  // 而这份坐标系 y 轴向下，所以 y 必须**减小**。原来的实现按计划书字面写成了
  // 加法,方向整个反了 —— 这条断言就是防它再反回去的。
  it("正的 baselineShift 让字形视觉向上，也就是 y 减小", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const shifted = layoutText({ content: "a", style: { size: 10, baselineShift: 5 } }, () => face);
    const plain = layoutText({ content: "a", style: { size: 10 } }, () => face);
    expect(shifted.ok && plain.ok).toBe(true);
    if (!shifted.ok || !plain.ok) return;
    expect(shifted.glyphs[0].y).toBe(plain.glyphs[0].y - 5);
  });

  it("负的 baselineShift 让字形下沉", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText({ content: "a", style: { size: 10, baselineShift: -3 } }, () => face);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs[0].y).toBe(3);
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

  it("五种忽略样式全部命中时都进 ignored，且跨 run 去重", () => {
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const ignoredStyle = {
      size: 10,
      underline: true,
      strikethrough: true,
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
      ["underline", "strikethrough", "fauxBold", "fauxItalic", "ligatures"].sort(),
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

  it("paragraphRuns：逐段 justification，不是整篇共用一个", () => {
    // 两段："ab"（居中）+ \n + "cd"（左对齐）。paragraphRuns 的 length 和
    // runs[] 同一套口径——顺次覆盖 content，第一段连着它后面的换行符一起算
    // 3 个字符，第二段是剩下的 2 个。
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText(
      {
        content: "ab\ncd",
        style: { size: 10 },
        paragraphRuns: [
          { length: 3, style: { justification: "center" } }, // "ab" + "\n"
          { length: 2, style: { justification: "left" } }, // "cd"
        ],
      },
      () => face,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 每行两个字形，每个宽 10px，行宽 20px。
    expect(out.glyphs).toHaveLength(4);
    expect(out.glyphs[0].x).toBe(-10); // 第一行居中：-width/2 = -10
    expect(out.glyphs[2].x).toBe(0); // 第二行左对齐：0
  });

  it("paragraphRuns 的偏移必须按 caps 展开之前的字符数算，否则会错位到别的段", () => {
    // 三段："ßß"（caps:"all" 展成 "SSSS"，4 个字形，居中）+ "c"（右对齐）
    // + "d"（左对齐）。如果实现错误地用“展开之后”的字符数去推第二、三段
    // 的起始偏移，"c" 那一行会算出偏大的 offset，套到相邻那个 run 的
    // justification 上——这里特意把相邻两个 run 的对齐设成不同的值
    // （center 和 right），一旦错位，"c" 行的断言就会失败。
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText(
      {
        content: "ßß\nc\nd",
        style: { size: 10, caps: "all" },
        paragraphRuns: [
          { length: 3, style: { justification: "center" } }, // "ß" + "ß" + "\n"（原始字符数，不是展开后的 4）
          { length: 1, style: { justification: "right" } }, // "c"
          { length: 1, style: { justification: "center" } }, // "\n"——故意放一个陷阱值，撞上错误实现就会被选中
          { length: 1, style: { justification: "left" } }, // "d"
        ],
      },
      () => face,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs.map(g => g.codePoint)).toEqual(
      ["S", "S", "S", "S", "C", "D"].map(c => c.codePointAt(0)),
    );
    expect(out.glyphs[0].x).toBe(-20); // "SSSS" 行宽 40，居中：-20
    expect(out.glyphs[4].x).toBe(-10); // "C" 行，右对齐：-width = -10（不是陷阱值 center 的 -5）
    expect(out.glyphs[5].x).toBe(0); // "D" 行，左对齐：0
  });

  it("没有 paragraphRuns 时退回 text.paragraphStyle（既有行为不变）", () => {
    // 两行都没有专属的 paragraph run，统一沿用顶层 paragraphStyle 的
    // justification——这是重构前的行为，重构后必须继续成立。
    const face = fakeFace({ advance: 1000, unitsPerEm: 1000 });
    const out = layoutText(
      {
        content: "ab\ncd",
        style: { size: 10 },
        paragraphStyle: { justification: "right" },
      },
      () => face,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.glyphs).toHaveLength(4);
    // 两行行宽都是 20px，右对齐首字形都应该是 -20。
    expect(out.glyphs[0].x).toBe(-20);
    expect(out.glyphs[2].x).toBe(-20);
  });
});

describe("静默丢弃是缺陷：影响输出的样式必须要么实现、要么进 ignored", () => {
  const face = () => fakeFace({ advance: 1000, unitsPerEm: 1000 });

  it("描边按 strokeWidth 报，不按 strokeColor —— 宽度才是描边存在的证据", () => {
    const out = layoutText({ content: "a", style: { size: 10, strokeWidth: 2 } }, () => face());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ignored).toContain("strokeWidth");
    // 报了不等于不画：字形照常产出。
    expect(out.glyphs).toHaveLength(1);
  });

  // 真实素材里**每个**文字层都带 strokeColor:{0,0,0}(Photoshop 默认值),而真正
  // 的开关 strokeFlag / outlineWidth 在 ag-psd 31.0.2 下一次都没解出来过。按颜色
  // 报就是每个文件都误报一次,而一条永远为真的警告会把旁边那些真警告一起废掉。
  it("光有 strokeColor 没有 strokeWidth 时不报 —— 那是 Photoshop 的默认值，不是描边", () => {
    const out = layoutText(
      { content: "a", style: { size: 10, strokeColor: { r: 0, g: 0, b: 0 } } },
      () => face(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ignored).toEqual([]);
  });

  it("段落级的间距与缩进进 ignored —— 它们按段走，不在逐字符那条路上", () => {
    const out = layoutText({
      content: "a",
      style: { size: 10 },
      paragraphStyle: { spaceBefore: 4, spaceAfter: 6, firstLineIndent: 8, startIndent: 2, endIndent: 3 },
    }, () => face());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const name of ["spaceBefore", "spaceAfter", "firstLineIndent", "startIndent", "endIndent"]) {
      expect(out.ignored).toContain(name);
    }
  });

  it("paragraphRuns 里的段落样式同样要被扫到", () => {
    const out = layoutText({
      content: "a\nb",
      style: { size: 10 },
      paragraphRuns: [
        { length: 2, style: { justification: "left" } },
        { length: 1, style: { spaceBefore: 5 } },
      ],
    }, () => face());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ignored).toContain("spaceBefore");
  });

  it("没设的字段不进 ignored —— 否则这个清单对 agent 毫无信息量", () => {
    const out = layoutText({ content: "a", style: { size: 10 } }, () => face());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ignored).toEqual([]);
  });
});

describe("horizontalScale / verticalScale 的回归", () => {
  // 这两个字段实现是对的,但此前一条测试都没覆盖 —— 谁删掉一处乘法都不会挂。
  // 默认轮廓就是占满 advance × unitsPerEm 的矩形，墨迹范围可精确预测。
  const face = () => fakeFace({ advance: 1000, unitsPerEm: 1000 });

  it("horizontalScale 让推进量按比例放大", () => {
    const plain = layoutText({ content: "ab", style: { size: 10 } }, () => face());
    const wide = layoutText({ content: "ab", style: { size: 10, horizontalScale: 2 } }, () => face());
    expect(plain.ok && wide.ok).toBe(true);
    if (!plain.ok || !wide.ok) return;
    expect(plain.glyphs[1].x).toBe(10);
    expect(wide.glyphs[1].x).toBe(20);
  });

  it("verticalScale 让墨迹高度按比例放大，宽度不变", () => {
    const plain = layoutText({ content: "a", style: { size: 10 } }, () => face());
    const tall = layoutText({ content: "a", style: { size: 10, verticalScale: 2 } }, () => face());
    expect(plain.ok && tall.ok).toBe(true);
    if (!plain.ok || !tall.ok) return;
    const h = (b: { top: number; bottom: number }) => b.bottom - b.top;
    const w = (b: { left: number; right: number }) => b.right - b.left;
    expect(h(tall.inkBounds)).toBeCloseTo(h(plain.inkBounds) * 2, 6);
    expect(w(tall.inkBounds)).toBeCloseTo(w(plain.inkBounds), 6);
  });
});
