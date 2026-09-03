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

/** 真 EffectContext：query 走真的 runQuery，blob 读写走同一个 memCas。 */
function effectCtx(model: PsdDoc, cas: Cas): EffectContext<PsdQuery> {
  return {
    query: async (q) => ({ data: await runQuery(q as PsdQuery, model, cas.ctx) as SValue, version: 1 }),
    readBlob: async (blob: SBlob): Promise<SBlobBytes> => {
      const handle = await cas.ctx.openSBlob(blob);
      return { data: await handle.readBytes({ offset: 0, length: handle.size }), contentType: handle.contentType };
    },
    writeBlob: (data: SBlobBytes) => cas.ctx.makeSBlob(data),
    signal: AbortSignal.timeout(60_000),
  } as EffectContext<PsdQuery>;
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
): Promise<RunResult> {
  const tool = createSetTextTool(source);
  if (tool.kind !== "effect") throw new Error("setText must be an effect tool");
  const out = await tool.run(args as never, effectCtx(model, cas));
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
    // layout.ts 的 rejectionReason 已经写成人话了，不重新包装。
    expect(String(structured.reason)).toContain("text.uneditable 非空");
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
