/**
 * `setText` effect + `set_text` op 的测试。
 *
 * 尽量不用桩：真的 `runQuery`、真的 `parseFontFace`（字体是 opentype.js 在
 * 内存里现造的，不提交任何第三方字体二进制）、真的
 * `createPsdDocumentType().apply`、真的 `storePsdDoc`/`materializePsdDoc`。
 * 两处替身：CAS 是内存实现 `memCas`，`EffectContext` 是这里手搓的（照
 * `edit-pixels-e2e.test.ts` 的 `effectCtx`），所以本文件**不覆盖** op 的
 * SValue 编解码往返。
 *
 * 字体是"每个字形的墨迹正好占满自己的步进宽度"的矩形字体（600x700，
 * advance 600），理由与 `buildGaplessTestFont` 一样：只有首尾相接的矩形才
 * 能让"N 个字符的墨迹宽度 = N x advance/unitsPerEm x size"这个等式成立，
 * 断言才写得出精确值。矩形**宽 600、高 700 不相等是刻意的** —— `inkBounds`
 * （`{left,top,right,bottom}`）和 `Layer.bounds`（`[top,left,bottom,right]`）
 * 前两位是反的，宽 = 高的用例对那个 bug 完全是瞎的。
 */
import { describe, expect, it } from "vitest";
import { decode } from "fast-png";
import type { EffectContext, SBlob, SBlobBytes, SValue } from "@unidocs/protocol";
import type { Layer, LayerText, PsdDoc } from "../src/model/types.js";
import { applyOne } from "../src/ops/index.js";
import { createPsdDocumentType } from "../src/doctype.js";
import { materializePsdDoc, storePsdDoc, type PsdStoredDoc } from "../src/state.js";
import { runQuery, type PsdQuery } from "../src/queries.js";
import { createPsdAgent } from "../src/agent.js";
import { createStubEditor } from "../src/testing/stub-editor.js";
import { createSetTextTool, type FontIndexSource } from "../src/text/set-text.js";
import { fontCoverage, parseFontFace } from "../src/text/opentype-face.js";
import type { FontEntry } from "../src/text/registry.js";
import { memCas } from "./helpers/mem-cas.js";
import { buildRectFont } from "./text-test-font.js";

const W = 200, H = 80;
/** 字号，px。每个字形宽 600/1000 x 20 = 12px，高 700/1000 x 20 = 14px。 */
const SIZE = 20;
const GLYPH_W = 12;
const GLYPH_H = 14;

/** 一套"墨迹占满步进宽度"的矩形字体，认识 A/B/C。 */
const rectFontBytes = (): Uint8Array => buildRectFont([
  { char: "A", width: 600, height: 700, advanceWidth: 600 },
  { char: "B", width: 600, height: 700, advanceWidth: 600 },
  { char: "C", width: 600, height: 700, advanceWidth: 600 },
]);

/** 只认识 `中`/`文` 的第二套字体，度量与 `rectFontBytes` 完全一样 —— 中英
 *  混排的场景里要断言的是"哪个字用了哪套字体"，度量再不一样就没法把版面
 *  的期望值手算出来了。 */
const cjkFontBytes = (): Uint8Array => buildRectFont([
  { char: "\u4e2d", width: 600, height: 700, advanceWidth: 600 },
  { char: "\u6587", width: 600, height: 700, advanceWidth: 600 },
]);

type Cas = ReturnType<typeof memCas>;

/**
 * 一个内存字体来源：字节进 memCas，索引里的 `coverage`/`unitsPerEm` 都是从
 * 字体文件**解析**出来的（与预置脚本的要求一致，不是人工填的）。
 */
async function fontSource(
  cas: Cas,
  entries: readonly { name: string; bytes: Uint8Array }[],
  fallbacks: readonly string[],
): Promise<FontIndexSource> {
  const index = new Map<string, FontEntry>();
  const blobs = new Map<string, SBlob>();
  for (const { name, bytes } of entries) {
    const blob = await cas.ctx.makeSBlob({ data: bytes, contentType: "font/otf" });
    const face = parseFontFace(bytes);
    index.set(name, {
      postScriptName: name,
      family: name,
      hash: blob.hash,
      unitsPerEm: face.unitsPerEm,
      coverage: fontCoverage(face),
    });
    blobs.set(blob.hash, blob);
  }
  return {
    load: async () => index,
    fallbacks,
    blobFor: (entry) => {
      const blob = blobs.get(entry.hash);
      if (!blob) throw new Error(`test font source: no blob for ${entry.postScriptName}`);
      return blob;
    },
  };
}

const BLACK = { r: 0, g: 0, b: 0 };
const RED = { r: 255, g: 0, b: 0 };

/** 两段样式不同的 runs：`A` 黑、`B` 红。跨这两段的替换必须被拒绝。 */
const twoRunText = (font = "TestFont"): LayerText => ({
  content: "AB",
  style: { font, size: SIZE, color: BLACK },
  runs: [
    { length: 1, style: { font, size: SIZE, color: BLACK } },
    { length: 1, style: { font, size: SIZE, color: RED } },
  ],
  paragraphStyle: { justification: "left" },
});

function textLayer(text: LayerText, bounds: [number, number, number, number]): Layer {
  const w = bounds[3] - bounds[1], h = bounds[2] - bounds[0];
  return {
    id: "title", type: "text", name: "title", bounds,
    opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
    // Photoshop 烘好的位图。setText 之后它会被换掉。
    pixels: { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) },
    text,
  };
}

/** 宽 40 x 高 20 的图层框，宽高不等 —— 与墨迹的宽高不等是两回事，两处都要不等。 */
const BOUNDS: [number, number, number, number] = [10, 20, 30, 60];

function doc(layer: Layer): PsdDoc {
  return {
    canvas: { width: W, height: H, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [layer],
  };
}

/** 真 EffectContext：query 走真的 runQuery，blob 读写走同一个 memCas。
 *  `readLog` 给它记账：`setText` 只用 `ctx.readBlob` 读**字体**字节（渲染那条
 *  路直接走 `cas.ctx`），所以这个日志就是"这次装载了哪几套字体"。 */
function effectCtx(model: PsdDoc, cas: Cas, readLog?: string[]): EffectContext<PsdQuery> {
  return {
    query: async (q) => ({ data: await runQuery(q as PsdQuery, model, cas.ctx) as SValue, version: 1 }),
    readBlob: async (blob: SBlob): Promise<SBlobBytes> => {
      readLog?.push(blob.hash);
      const handle = await cas.ctx.openSBlob(blob);
      return { data: await handle.readBytes({ offset: 0, length: handle.size }), contentType: handle.contentType };
    },
    writeBlob: (data: SBlobBytes) => cas.ctx.makeSBlob(data),
    signal: AbortSignal.timeout(60_000),
  } as EffectContext<PsdQuery>;
}

/** 解码出来的 PNG，只留断言要用的三样。 */
interface DecodedPng { width: number; height: number; data: ArrayLike<number> }

async function decodePng(cas: Cas, blob: SBlob): Promise<DecodedPng> {
  const handle = await cas.ctx.openSBlob(blob);
  const png = decode(await handle.readBytes({ offset: 0, length: handle.size }));
  return { width: png.width, height: png.height, data: png.data as ArrayLike<number> };
}

/** (x, y) 处的 alpha，0..255。 */
const alphaAt = (png: DecodedPng, x: number, y: number): number =>
  Number(png.data[(y * png.width + x) * 4 + 3]);

/** 完全不透明（alpha === 255）的像素个数。矩形测试字体的边缘正好落在整数
 *  像素边界上，覆盖率恰好是 1，不会有抗锯齿的中间值。 */
function fullyOpaqueCount(png: DecodedPng): number {
  let n = 0;
  for (let i = 3; i < png.data.length; i += 4) if (Number(png.data[i]) === 255) n++;
  return n;
}

interface RunResult {
  ops: readonly { kind: string; payload: Record<string, unknown> }[];
  structured: Record<string, unknown>;
  text: string;
}

/** 跑一次 setText，返回 op 与结构化结果。 */
async function runSetText(
  cas: Cas,
  model: PsdDoc,
  source: FontIndexSource,
  args: Record<string, unknown>,
  readLog?: string[],
): Promise<RunResult> {
  const tool = createSetTextTool(source);
  if (tool.kind !== "effect") throw new Error("setText must be an effect tool");
  const out = await tool.run(args as never, effectCtx(model, cas, readLog));
  const parts = out.result.content ?? [];
  const textPart = parts.find(p => p.type === "text") as { text: string } | undefined;
  return {
    ops: out.ops as unknown as RunResult["ops"],
    structured: out.result.structuredContent as Record<string, unknown>,
    text: textPart?.text ?? "",
  };
}

/** 默认场景：一套认识 A/B/C 的字体，请求的就是它。 */
async function scene(text: LayerText = twoRunText(), bounds = BOUNDS): Promise<{
  cas: Cas; model: PsdDoc; source: FontIndexSource;
}> {
  const cas = memCas();
  const source = await fontSource(cas, [{ name: "TestFont", bytes: rectFontBytes() }], ["TestFont"]);
  return { cas, model: doc(textLayer(text, bounds)), source };
}

describe("setText：成功路径", () => {
  it("content 换成新值、runs 按改动区间重切、pixels 换新 blob、bounds 左对齐时左边不动", async () => {
    const { cas, model, source } = await scene();

    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });

    expect(structured.ok).toBe(true);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("set_text");
    const p = ops[0].payload as {
      text: LayerText;
      pixels: { width: number; height: number; hash: string; blob: SBlob };
      bounds: [number, number, number, number];
      provenance: { model: string; prompt: string };
      fonts: { postScriptName: string; blob: SBlob }[];
    };

    expect(p.text.content).toBe("AAA");
    // "AB" → "AAA" 的改动区间是 [1,2) 插 2 个字符，新字符继承被替换掉那段
    // （红色）的样式 —— 与文本编辑器里替换选区的行为一致。
    expect(p.text.runs).toEqual([
      { length: 1, style: { font: "TestFont", size: SIZE, color: BLACK } },
      { length: 2, style: { font: "TestFont", size: SIZE, color: RED } },
    ]);

    // ⚠️ 宽高故意不等：36 x 14。写成 [left,top,right,bottom] 这一条会变红。
    expect(p.bounds).toEqual([10, 20, 10 + GLYPH_H, 20 + 3 * GLYPH_W]);
    expect([p.pixels.width, p.pixels.height]).toEqual([3 * GLYPH_W, GLYPH_H]);
    expect(p.pixels.width).not.toBe(p.pixels.height);

    // 新像素真的在 CAS 里，且解码出来就是 bounds 的尺寸。
    const handle = await cas.ctx.openSBlob(p.pixels.blob);
    expect(handle.contentType).toBe("image/png");
    const png = decode(await handle.readBytes({ offset: 0, length: handle.size }));
    expect([png.width, png.height]).toEqual([3 * GLYPH_W, GLYPH_H]);
    expect(p.pixels.hash).toBe(p.pixels.blob.hash);
    // 不是原来那份烘焙位图（那是 40x20 的全零像素）。
    expect([png.width, png.height]).not.toEqual([40, 20]);

    // 这层像素不再是 Photoshop 烘的，记在案上；没有 seed 字段（自研排版链
    // 没有种子这回事，记一个默认 0 等于假装可复现）。
    expect(p.provenance.model).toBe("unidocs-text-layout");
    expect(p.provenance.prompt).toBe("AAA");
    expect("seed" in p.provenance).toBe(false);

    // 用到的字体跟着 op 走，落地时进 doc.fonts 保活。
    expect(p.fonts.map(f => f.postScriptName)).toEqual(["TestFont"]);
  });

  it("右对齐时右边不动，居中时中心不动", async () => {
    for (const [justification, expected] of [
      ["right", [10, 60 - 3 * GLYPH_W, 10 + GLYPH_H, 60]],
      ["center", [10, (20 + 60) / 2 - 3 * GLYPH_W / 2, 10 + GLYPH_H, (20 + 60) / 2 + 3 * GLYPH_W / 2]],
    ] as const) {
      const text = { ...twoRunText(), paragraphStyle: { justification } };
      const { cas, model, source } = await scene(text as LayerText);
      const { ops } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
      const bounds = (ops[0].payload as { bounds: number[] }).bounds;
      expect(bounds, `justification=${justification}`).toEqual(expected);
    }
  });

  it("没有 runs 的文字层照样能改（整层一个 style），且不凭空造出 runs", async () => {
    const text: LayerText = {
      content: "AB",
      style: { font: "TestFont", size: SIZE, color: BLACK },
      paragraphStyle: { justification: "left" },
    };
    const { cas, model, source } = await scene(text);
    const { ops } = await runSetText(cas, model, source, { layerId: "title", text: "ABC" });
    const p = ops[0].payload as { text: LayerText };
    expect(p.text.content).toBe("ABC");
    expect(p.text.runs).toBeUndefined();
  });

  /**
   * 像素断言。上面那几条只把 PNG decode 出来看了宽高 —— 把栅格化的 `origin`
   * 写错，输出一整张**纯透明** PNG，宽高照样是对的。"自己排版、自己栅格化"
   * 的全部价值就在墨迹落到哪儿。
   *
   * 手算（矩形字体：轮廓 600x700 font units、advance 600、unitsPerEm 1000，
   * size 20 → 每个字形 12x14 px，墨迹正好占满自己的步进宽度）：
   *   排版：基线 y = 0，第 i 个字形 x = 12i，轮廓在文档坐标系（y 轴向下）里占
   *         x ∈ [12i, 12i+12)、y ∈ [-14, 0)
   *   "AAA" → inkBounds = {left:0, top:-14, right:36, bottom:0}
   *   左对齐 → 图层框左上角沿用旧框 (left=20, top=10) → bounds = [10,20,24,56]，
   *         画布 36 x 14
   *   origin = {x: 0 + (20-20), y: -14 + (10-10)} = {x:0, y:-14}
   *         → 画布里第 i 个字形占 x ∈ [12i, 12i+12)、y ∈ [0, 14)
   * 三个字形首尾相接、竖直方向占满整幅 → 36 x 14 = 504 个像素**全部**不透明。
   */
  it("栅格化：三个字形铺满 36x14 的画布，504 个像素一个不漏", async () => {
    const { cas, model, source } = await scene();
    const { ops } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
    const p = ops[0].payload as { pixels: { blob: SBlob } };

    const png = await decodePng(cas, p.pixels.blob);
    expect([png.width, png.height]).toEqual([3 * GLYPH_W, GLYPH_H]);
    expect(fullyOpaqueCount(png)).toBe(3 * GLYPH_W * GLYPH_H);
    // 四角各抽一个：墨迹整体平移一个像素，这四条里至少有一条会掉。
    expect(alphaAt(png, 0, 0)).toBe(255);
    expect(alphaAt(png, 3 * GLYPH_W - 1, 0)).toBe(255);
    expect(alphaAt(png, 0, GLYPH_H - 1)).toBe(255);
    expect(alphaAt(png, 3 * GLYPH_W - 1, GLYPH_H - 1)).toBe(255);
  });

  /**
   * 两行文字：画布上有**本来就该透明**的地方，所以这条抓得住"墨迹整体平移"，
   * 上面那条满幅的抓不住。
   *
   * 手算（size 20，没有显式 leading → 行距 = 20 x 1.2 = 24）：
   *   第 1 行 "A" ：基线 y = 0 ，墨迹 x ∈ [0,12)、y ∈ [-14, 0)
   *   第 2 行 "AA"：基线 y = 24，墨迹 x ∈ [0,24)、y ∈ [ 10, 24)
   *   inkBounds = {left:0, top:-14, right:24, bottom:24} → 24 x 38
   *   左对齐 → bounds = [10, 20, 10+38, 20+24] = [10, 20, 48, 44]
   *   origin = {x:0, y:-14} → 画布 y = 文档 y + 14：
   *     第 1 行 → x ∈ [0,12)、y ∈ [ 0, 14)
   *     第 2 行 → x ∈ [0,24)、y ∈ [24, 38)
   *   不透明像素 = 12x14 + 24x14 = 168 + 336 = 504；画布共 24 x 38 = 912。
   */
  it("栅格化：两行文字的墨迹落点逐点手算，行间的空隙必须是透明的", async () => {
    const { cas, model, source } = await scene({
      content: "A",
      style: { font: "TestFont", size: SIZE, color: BLACK },
      paragraphStyle: { justification: "left" },
    });
    const { ops } = await runSetText(cas, model, source, { layerId: "title", text: "A\nAA" });
    const p = ops[0].payload as { bounds: number[]; pixels: { blob: SBlob } };
    expect(p.bounds).toEqual([10, 20, 48, 44]);

    const png = await decodePng(cas, p.pixels.blob);
    expect([png.width, png.height]).toEqual([24, 38]);
    expect(fullyOpaqueCount(png)).toBe(504);
    // 第 1 行只有一个字形宽：左半边是墨迹，右半边（第 2 行才够得着的那些列）不是。
    expect(alphaAt(png, 0, 0)).toBe(255);
    expect(alphaAt(png, 11, 13)).toBe(255);
    expect(alphaAt(png, 12, 0)).toBe(0);
    // 两行之间的空隙：文档 y ∈ [0,10) → 画布 y ∈ [14,24)。
    expect(alphaAt(png, 0, 14)).toBe(0);
    expect(alphaAt(png, 0, 23)).toBe(0);
    // 第 2 行：整整 24 像素宽、14 像素高。
    expect(alphaAt(png, 0, 24)).toBe(255);
    expect(alphaAt(png, 23, 24)).toBe(255);
    expect(alphaAt(png, 23, 37)).toBe(255);
  });

  it("没还原的样式（underline）进 structuredContent.ignored，人话里也说得出来", async () => {
    const { cas, model, source } = await scene({
      content: "AB",
      style: { font: "TestFont", size: SIZE, color: BLACK, underline: true },
      paragraphStyle: { justification: "left" },
    });
    const { ops, structured, text } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
    expect(structured.ok).toBe(true);
    expect(ops).toHaveLength(1);
    expect(structured.ignored).toEqual(["underline"]);
    // 不说出来的话，这次编辑会被当成"和原来一模一样，只是换了几个字"。
    expect(text).toContain("NOT REPRODUCED");
    expect(text).toContain("underline");
  });

  /**
   * `paragraphRuns` 的重切分，外加"图层框的锚点取**第一段**的对齐"。
   *
   * 两段：第 1 段 `"A\n"`（居中，length 2）、第 2 段 `"A"`（左对齐，length 1）。
   * 改成 `"AA\nA"`，`diffRange` 夹出来的是"在偏移 1 处纯插入 1 个字符"，落在
   * 第 1 段里 → 第 1 段 2 → 3，第 2 段不动。
   *
   * bounds 手算：第 1 行 "AA" 居中 → 行宽 24、偏移 -12，墨迹 x ∈ [-12, 12)；
   * 第 2 行 "A" 左对齐 → x ∈ [0, 12)。inkBounds.left = -12、right = 12 → 宽 24；
   * 高与上一条一样 = 38。锚点取第一段的 center → 旧框中心 (20+60)/2 = 40，
   * left = 40 - 24/2 = 28 → bounds = [10, 28, 48, 52]。锚点若误用了
   * `paragraphStyle`（这层根本没有）会退成左对齐，left 就成了 20。
   */
  it("paragraphRuns 按改动区间重切，图层框的锚点取第一段的对齐方式", async () => {
    const twoParagraphs = (): LayerText => ({
      content: "A\nA",
      style: { font: "TestFont", size: SIZE, color: BLACK },
      paragraphRuns: [
        { length: 2, style: { justification: "center" } },
        { length: 1, style: { justification: "left" } },
      ],
    });
    const { cas, model, source } = await scene(twoParagraphs());
    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "AA\nA" });
    expect(structured.ok).toBe(true);
    const p = ops[0].payload as { text: LayerText; bounds: number[] };
    expect(p.text.paragraphRuns).toEqual([
      { length: 3, style: { justification: "center" } },
      { length: 1, style: { justification: "left" } },
    ]);
    expect(p.bounds).toEqual([10, 28, 48, 52]);

    // 再真落地一次：op 那边校验 paragraphRuns 的长度和，切错了会当场炸。
    const next = applyOne(model, { kind: "set_text", payload: ops[0].payload });
    expect(next.layers[0].text?.paragraphRuns).toEqual(p.text.paragraphRuns);
  });

  /**
   * caps 展开是**载荷承重**的，不是锦上添花：选字体必须按展开之后的码位查
   * 覆盖。这层 `caps: "all"`、内容 `"abc"`，而字体只有 A/B/C 三个字形 ——
   * 按原字符（小写）查覆盖会一套字体都装不上，三个字全成 missing，整层失败。
   */
  it("caps:\"all\" 的层：按展开后的大写查覆盖，abc 用只认识 A/B/C 的字体照样排得出来", async () => {
    const { cas, model, source } = await scene({
      content: "a",
      style: { font: "TestFont", size: SIZE, color: BLACK, caps: "all" },
      paragraphStyle: { justification: "left" },
    });
    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "abc" });
    expect(structured.ok).toBe(true);
    expect(structured.missing).toEqual([]);
    expect((ops[0].payload as { bounds: number[] }).bounds)
      .toEqual([10, 20, 10 + GLYPH_H, 20 + 3 * GLYPH_W]);
  });
});

describe("setText：只装真正用得上的字体", () => {
  it("索引里两套字体、内容纯英文 → 只从 CAS 读了英文那套", async () => {
    const cas = memCas();
    const source = await fontSource(cas, [
      { name: "Latin", bytes: rectFontBytes() },
      { name: "CJK", bytes: cjkFontBytes() },
    ], ["Latin", "CJK"]);
    const index = await source.load();
    const model = doc(textLayer({
      content: "A",
      style: { font: "Latin", size: SIZE, color: BLACK },
      paragraphStyle: { justification: "left" },
    }, BOUNDS));

    // 记账，不是数出来的感觉：中文兜底字体动辄十几 MB，"先都装上再说"这种
    // 改法在功能上看不出区别，只有把 readBlob 的调用记下来才挡得住。
    const readLog: string[] = [];
    const { ops, structured } = await runSetText(
      cas, model, source, { layerId: "title", text: "AAA" }, readLog,
    );

    expect(structured.ok).toBe(true);
    expect(readLog).toEqual([index.get("Latin")!.hash]);
    expect((ops[0].payload as { fonts: { postScriptName: string }[] }).fonts.map(f => f.postScriptName))
      .toEqual(["Latin"]);
  });
});

describe("setText：模型能改措辞绕开的失败，返回 fail 而不是抛", () => {
  it("替换跨越样式不同的两段 → 拒绝，并给出\"分两次改\"这条可执行建议", async () => {
    const { cas, model, source } = await scene();
    // "AB" → "XY" 整串都变，同时碰到黑段和红段。
    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "XY" });
    expect(ops).toEqual([]); // 不写文档、不涨版本
    expect(structured.ok).toBe(false);
    expect(String(structured.reason)).toContain("TWO calls");
    expect((structured.detail as { kind: string }).kind).toBe("spans-runs");
  });

  it("layoutText 拒绝时 reason 原样透出（uneditable 非空）", async () => {
    const { cas, model, source } = await scene({ ...twoRunText(), uneditable: ["warp"] });
    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
    expect(ops).toEqual([]);
    expect(structured.ok).toBe(false);
    // layout.ts 的 typesetRejection 已经写成人话了，不重新包装。英文 ——
    // 这条 reason 原样透给模型，而工具面其余部分都是英文。
    expect(String(structured.reason)).toContain("text.uneditable is non-empty");
    expect(String(structured.reason)).toContain("warp");
  });

  it("目标不是文字层 → 拒绝，说清它是什么类型", async () => {
    const cas = memCas();
    const source = await fontSource(cas, [{ name: "TestFont", bytes: rectFontBytes() }], ["TestFont"]);
    const raster: Layer = {
      id: "title", type: "raster", name: "photo", bounds: BOUNDS,
      opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
      pixels: { width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4) },
    };
    const { ops, structured } = await runSetText(cas, doc(raster), source, { layerId: "title", text: "AAA" });
    expect(ops).toEqual([]);
    expect(String(structured.reason)).toContain("raster");
  });

  it("text.transform 的线性部分不是单位阵 → 拒绝（整体缩放算错，输出整个是错的）", async () => {
    // 2 倍自由变换的点文字层。排版链按 1:1 排、按 1:1 画，改一次字就把这层
    // 当场缩掉一半 —— 所以归 fail，不是记进 ignored（ignored 的语义是"少还原
    // 了一个下划线"，其余部分仍然正确）。
    const { cas, model, source } = await scene({ ...twoRunText(), transform: [2, 0, 0, 2, 100, 50] });
    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
    expect(ops).toEqual([]);
    expect(structured.ok).toBe(false);
    expect(structured.ignored).toBeUndefined();
    expect(String(structured.reason)).toContain("non-identity text transform");
    expect((structured.detail as { kind: string }).kind).toBe("non-identity-transform");
    // 矩阵本身也要断言：它是 agent 唯一能拿来向用户解释"这层被缩放了 2 倍"
    // 的东西。只断言 kind 的话,detail 里塞一个空数组照样绿。
    expect((structured.detail as { transform: number[] }).transform).toEqual([2, 0, 0, 2, 100, 50]);
  });

  it("纯平移的 transform 不算 → 照常成功（点文字的锚点本来就靠 e/f 定位）", async () => {
    const { cas, model, source } = await scene({ ...twoRunText(), transform: [1, 0, 0, 1, 100, 50] });
    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
    expect(structured.ok).toBe(true);
    expect((ops[0].payload as { bounds: number[] }).bounds)
      .toEqual([10, 20, 10 + GLYPH_H, 20 + 3 * GLYPH_W]);
  });

  it("清空文字 → 拒绝，并指出该用 setProps/removeLayer", async () => {
    const { cas, model, source } = await scene();
    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "" });
    expect(ops).toEqual([]);
    expect(String(structured.reason)).toContain("setProps");
    expect(String(structured.reason)).toContain("removeLayer");
  });

  it("整条回退链都画不出任何一个字 → 拒绝，不产出 0x0 的图层", async () => {
    // 整层一个样式，免得先被 spans-runs 拦下来 —— 这条要测的是排版之后的那道闸。
    const { cas, model, source } = await scene({
      content: "AB",
      style: { font: "TestFont", size: SIZE, color: BLACK },
      paragraphStyle: { justification: "left" },
    });
    // 字体只认识 A/B/C；改成中文一个字形都取不到。
    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "中文" });
    expect(ops).toEqual([]);
    expect(structured.ok).toBe(false);
    expect(structured.missing).toEqual(["中".codePointAt(0), "文".codePointAt(0)]);
  });
});

describe("setText：缺字体自动回退 + 显式报告", () => {
  it("请求的字体整套不在索引里 → 编辑照样成功，但结果里说清用了谁替代", async () => {
    const cas = memCas();
    // 索引里只有兜底字体，图层请求的 JosefinSans-Bold 根本不在。
    const source = await fontSource(cas, [{ name: "NotoSans", bytes: rectFontBytes() }], ["NotoSans"]);
    const model = doc(textLayer(twoRunText("JosefinSans-Bold"), BOUNDS));

    const { ops, structured, text } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });

    // 自动兜底：编辑成功，不是停下来让用户三选一。
    expect(structured.ok).toBe(true);
    expect(ops).toHaveLength(1);
    // 显式报告：请求的是 X、实际用了 Y。
    expect(structured.fontFallbacks).toEqual([
      { requested: "JosefinSans-Bold", usedInstead: ["NotoSans"] },
    ]);
    expect(text).toContain("JosefinSans-Bold");
    expect(text).toContain("NotoSans");
    // 字形与版面会变 —— 这句必须在，不然模型会把结果当成一模一样。
    expect(text).toContain("WILL differ");
    // 整套缺席已经在 fontFallbacks 里说清楚了，不在逐码位那一档重复记一遍
    // —— 否则一段纯英文会为每个字符都报同一件事。
    expect(structured.glyphFallbacks).toEqual([]);
  });

  it("请求的字体在、只是不认识那几个字 → 逐码位兜底也要报出来，不许静默换字形", async () => {
    const cas = memCas();
    const source = await fontSource(cas, [
      { name: "Latin", bytes: rectFontBytes() },
      { name: "CJK", bytes: cjkFontBytes() },
    ], ["Latin", "CJK"]);
    const model = doc(textLayer({
      content: "A",
      style: { font: "Latin", size: SIZE, color: BLACK },
      paragraphStyle: { justification: "left" },
    }, BOUNDS));

    const { ops, structured, text } = await runSetText(
            // "中"故意出现两次：glyphFallbacks.chars 的期望值仍只有一个"中",
      // 钉住去重。不去重的话同一个字缺 20 遍就报 20 遍。
      cas, model, source, { layerId: "title", text: "A\u4e2d\u6587\u4e2d" },
    );

    expect(structured.ok).toBe(true);
    // 三个字都画出来了，所以既不是 missing、也不是"整套字体不在"。
    expect(structured.missing).toEqual([]);
    expect(structured.fontFallbacks).toEqual([]);
    expect((ops[0].payload as { bounds: number[] }).bounds)
      .toEqual([10, 20, 10 + GLYPH_H, 20 + 4 * GLYPH_W]);
    // 中英混排编辑里最常发生的一档：用户加两个中文字，字形变了得有人说。
    // 内容里"中"出现两次,期望值仍只有一个 —— 钉住 chars 的去重。
    // 不去重的话同一个字缺 20 遍就报 20 遍,人话会被噪音淹掉。
    expect(structured.glyphFallbacks).toEqual([
      { requested: "Latin", used: "CJK", chars: ["\u4e2d", "\u6587"] },
    ]);
    // 只断言两个名字都在，把它们对调位置照样绿 —— 而说反了就是在告诉用户
    // "中文字用的是 Latin"，比不说更糟。所以断言的是因果方向本身。
    expect(text).toMatch(/drawn with "CJK"/);
    expect(text).toMatch(/"Latin" has no glyph/);
    expect(text).toContain("WILL differ");
  });

  it("字体在、但缺个别码位 → 成功，missing 报出那些字", async () => {
    const { cas, model, source } = await scene();
    const { ops, structured } = await runSetText(cas, model, source, { layerId: "title", text: "AA中" });
    expect(structured.ok).toBe(true);
    expect(ops).toHaveLength(1);
    expect(structured.missing).toEqual(["中"]);
    // 缺的字不占位，所以墨迹只有两个字形宽。
    expect((ops[0].payload as { bounds: number[] }).bounds).toEqual([10, 20, 10 + GLYPH_H, 20 + 2 * GLYPH_W]);
  });
});

describe("set_text op 的校验", () => {
  const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    layerId: "title",
    text: { content: "AAA", runs: [{ length: 3, style: {} }] },
    pixels: { width: 4, height: 4, hash: "x".repeat(64) },
    bounds: [10, 20, 24, 56],
    provenance: { model: "unidocs-text-layout", prompt: "AAA" },
    ...over,
  });

  const base = (): PsdDoc => doc(textLayer(twoRunText(), BOUNDS));

  it("图层不存在 → 抛", () => {
    expect(() => applyOne(base(), { kind: "set_text", payload: payload({ layerId: "nope" }) }))
      .toThrow(/layer not found: nope/);
  });

  it("图层不是 text 类型 → 抛", () => {
    const d = base();
    d.layers[0].type = "raster";
    expect(() => applyOne(d, { kind: "set_text", payload: payload() }))
      .toThrow(/is not a text layer/);
  });

  it("runs 的长度之和与 content 长度对不上 → 抛（落地了样式会永久错位）", () => {
    const bad = payload({ text: { content: "AAA", runs: [{ length: 2, style: {} }] } });
    expect(() => applyOne(base(), { kind: "set_text", payload: bad }))
      .toThrow(/runs length 2 does not cover content length 3/);
  });

  it("bounds 不是四个有限数 → 抛", () => {
    expect(() => applyOne(base(), { kind: "set_text", payload: payload({ bounds: [10, 20, 24] }) }))
      .toThrow(/bounds must be four finite numbers/);
    expect(() => applyOne(base(), { kind: "set_text", payload: payload({ bounds: [10, 20, 24, Number.NaN] }) }))
      .toThrow(/bounds must be four finite numbers/);
  });

  it("text.content 不是字符串（或压根没有 text）→ 抛", () => {
    expect(() => applyOne(base(), { kind: "set_text", payload: payload({ text: { content: 42 } }) }))
      .toThrow(/text\.content must be a string/);
    expect(() => applyOne(base(), { kind: "set_text", payload: payload({ text: undefined }) }))
      .toThrow(/text\.content must be a string/);
  });

  it("paragraphRuns 的长度之和与 content 长度对不上 → 抛（逐行对齐会静默套错段）", () => {
    const bad = payload({
      text: { content: "AAA", runs: [{ length: 3, style: {} }], paragraphRuns: [{ length: 2, style: {} }] },
    });
    expect(() => applyOne(base(), { kind: "set_text", payload: bad }))
      .toThrow(/paragraphRuns length 2 does not cover content length 3/);
  });

  it("校验通过时把 text/pixels/bounds/provenance 都写进图层", () => {
    const next = applyOne(base(), { kind: "set_text", payload: payload() });
    const l = next.layers[0];
    expect(l.text?.content).toBe("AAA");
    expect(l.bounds).toEqual([10, 20, 24, 56]);
    expect(l.pixels).toEqual({ width: 4, height: 4, hash: "x".repeat(64) });
    expect(l.provenance).toEqual({ model: "unidocs-text-layout", prompt: "AAA" });
  });

  it("fonts 是合并进 doc.fonts 的，不是替换 —— 别的文字层的保活引用不能被抹掉", async () => {
    const cas = memCas();
    const blobA = await cas.ctx.makeSBlob({ data: new TextEncoder().encode("a"), contentType: "font/otf" });
    const blobB = await cas.ctx.makeSBlob({ data: new TextEncoder().encode("b"), contentType: "font/otf" });
    const d = base();
    d.fonts = [{ postScriptName: "Other", blob: blobA }];
    const next = applyOne(d, {
      kind: "set_text",
      payload: payload({ fonts: [{ postScriptName: "TestFont", blob: blobB }] }),
    });
    expect(next.fonts?.map(f => f.postScriptName)).toEqual(["Other", "TestFont"]);
  });
});

describe("setText 端到端：真 op 落到真 PsdDoc，再往返一次持久化", () => {
  it("apply 接得住，content/runs/fonts 过了 storePsdDoc/materializePsdDoc 都不丢", async () => {
    const cas = memCas();
    const source = await fontSource(cas, [{ name: "TestFont", bytes: rectFontBytes() }], ["TestFont"]);
    const state0: PsdStoredDoc = await storePsdDoc(doc(textLayer(twoRunText(), BOUNDS)), cas.ctx);
    const bakedHash = state0.layers[0].pixels?.blob?.hash;
    expect(typeof bakedHash).toBe("string");

    const model0 = await materializePsdDoc(state0, cas.ctx);
    const { ops, structured } = await runSetText(cas, model0, source, { layerId: "title", text: "AAA" });
    expect(structured.ok).toBe(true);

    const dt = createPsdDocumentType(cas.ctx);
    const state1 = await dt.apply(ops as never, state0);

    // 落库之后再取出来 —— 走的是 DO 的持久化那条路。
    const model1 = await materializePsdDoc(state1, cas.ctx);
    const layer = model1.layers[0];
    expect(layer.text?.content).toBe("AAA");
    expect(layer.text?.runs).toEqual([
      { length: 1, style: { font: "TestFont", size: SIZE, color: BLACK } },
      { length: 2, style: { font: "TestFont", size: SIZE, color: RED } },
    ]);
    expect(layer.bounds).toEqual([10, 20, 10 + GLYPH_H, 20 + 3 * GLYPH_W]);
    // 烘焙位图被换掉了。
    expect(layer.pixels?.hash).not.toBe(bakedHash);
    // 字体被钉在文档上 —— 只被租户索引引用的字体会被 CAS 的 GC 回收。
    expect(model1.fonts?.map(f => f.postScriptName)).toEqual(["TestFont"]);
    expect(state1.fonts?.[0].blob.hash).toBe(model1.fonts![0].blob.hash);

    // 改完还渲得出来：新像素是惰性 PixelRef，没有把渲染打断。
    const preview = await dt.query({ kind: "getPreview" }, state1) as unknown as { image: SBlob; width: number };
    expect(preview.width).toBe(W);
    expect((await cas.ctx.openSBlob(preview.image)).size).toBeGreaterThan(0);
  });
});

describe("工具表与提示词必须一起条件化", () => {
  const source: FontIndexSource = {
    load: async () => new Map(),
    fallbacks: [],
    blobFor: () => { throw new Error("unused"); },
  };

  it("没有 fontIndex 时，工具表和提示词里都没有 setText", () => {
    const agent = createPsdAgent({});
    expect(agent.tools.map(t => t.name)).not.toContain("setText");
    expect(agent.instructions).not.toContain("setText");
  });

  it("有 fontIndex 时，工具表和提示词里都有 setText，且它是 effect", () => {
    const agent = createPsdAgent({ fontIndex: source });
    expect(agent.tools.find(t => t.name === "setText")?.kind).toBe("effect");
    expect(agent.instructions).toContain("setText");
  });

  it("只注入 fontIndex 时，setText 的说明块不许提 editPixels —— 那才是幽灵工具", () => {
    const agent = createPsdAgent({ fontIndex: source });
    expect(agent.tools.map(t => t.name)).not.toContain("editPixels");
    expect(agent.instructions).not.toContain("editPixels");
  });

  it("两个都注入时两个都在，互不干扰", () => {
    const agent = createPsdAgent({ editor: createStubEditor(), fontIndex: source });
    const names = agent.tools.map(t => t.name);
    expect(names).toContain("setText");
    expect(names).toContain("editPixels");
    expect(agent.instructions).toContain("setText");
    expect(agent.instructions).toContain("editPixels");
  });
});

/**
 * `getLayers` 报出去的 `editable` 与 `setText` 到底收不收，**必须一致**。
 *
 * 这条守的是整分支最后一轮评审抓到的那个缺陷：`editable` 早先只看
 * `text.uneditable`，而框文字 / 竖排 / 缩放 transform 三种拒绝**都不进那个
 * 字段**，于是 `getLayers` 对它们报 `editable: true`；提示词又规定
 * "editable true → 必须用 setText，绝不许用 editPixels"，逃生出口只在
 * `editable === false` 时才开。结果是模型收到拒绝、无路可走、道歉停下 ——
 * 和这条分支要消灭的那次原始故障一模一样的结局，而且这次连 editPixels
 * 都不许试。框文字是真实 PSD 里最常见的正文形态，所以这不是边角情形。
 *
 * 现在两边共用 `typesetRejection`（`text/layout.ts`），下面逐种核对。
 */
describe("editable 与 setText 的接受与否一致", () => {
  const cases: { name: string; text: LayerText }[] = [
    { name: "warp（进 uneditable，一直是对的）", text: { ...twoRunText(), uneditable: ["warp"] } },
    { name: "框文字（不进 uneditable —— 真实 PSD 正文最常见的形态）", text: { ...twoRunText(), boxBounds: [0, 0, 100, 40] } },
    { name: "竖排（不进 uneditable）", text: { ...twoRunText(), orientation: "vertical" } },
    { name: "缩放 transform（不进 uneditable）", text: { ...twoRunText(), transform: [2, 0, 0, 2, 100, 50] } },
  ];

  for (const c of cases) {
    it(`${c.name}：getLayers 说不可编辑，setText 也确实拒绝`, async () => {
      const { cas, model, source } = await scene(c.text);
      // getLayers 直接返回图层数组，不是 { layers: [...] }（queries.ts:238）。
      const layers = await runQuery({ kind: "getLayers" } as PsdQuery, model, cas.ctx) as unknown as
        { id: string; text?: { editable: boolean } }[];
      const summary = layers.find(l => l.id === "title");
      const { structured } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
      // 一致性本身就是断言：两边都必须说"不行"。
      expect({ editable: summary?.text?.editable, accepted: structured.ok })
        .toEqual({ editable: false, accepted: false });
    });
  }

  it("正常点文字：两边都说行", async () => {
    const { cas, model, source } = await scene();
    const layers = await runQuery({ kind: "getLayers" } as PsdQuery, model, cas.ctx) as unknown as
      { id: string; text?: { editable: boolean } }[];
    const summary = layers.find(l => l.id === "title");
    const { structured } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
    expect({ editable: summary?.text?.editable, accepted: structured.ok })
      .toEqual({ editable: true, accepted: true });
  });
});

describe("setText 成功之后不再挂着「渲染用的是烘焙像素」", () => {
  it("那条降级记录被摘掉,别的降级不受影响", async () => {
    // 导入时每个文字层都会挂上"文字层已栅格化 / 渲染与导出使用 PSD 烘焙像素"。
    // setText 成功之后像素已经是本仓库排版链自己排的,那句话就成了错的 ——
    // 模型复核时会同时读到它和 provenance.model = "unidocs-text-layout",
    // 轻则措辞含糊,重则以为编辑没生效而重试。
    const { cas, model, source } = await scene();
    const layer = model.layers[0];
    layer.degraded = [
      { reason: "文字层已栅格化", detail: "渲染与导出使用 PSD 烘焙像素；文字内容可编辑" },
      { reason: "矢量形状已栅格化", detail: "别的降级,仍然成立" },
    ];
    const { ops } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
    const next = applyOne(model, ops[0] as never);
    expect(next.layers[0].degraded).toEqual([
      { reason: "矢量形状已栅格化", detail: "别的降级,仍然成立" },
    ]);
  });

  it("只有那一条时,整个 degraded 字段消失(不是留一个空数组)", async () => {
    const { cas, model, source } = await scene();
    model.layers[0].degraded = [{ reason: "文字层已栅格化", detail: "渲染与导出使用 PSD 烘焙像素" }];
    const { ops } = await runSetText(cas, model, source, { layerId: "title", text: "AAA" });
    const next = applyOne(model, ops[0] as never);
    expect("degraded" in next.layers[0]).toBe(false);
  });
});
