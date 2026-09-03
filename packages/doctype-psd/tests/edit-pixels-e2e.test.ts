/**
 * editPixels 的端到端：把 effect 真正吐出来的 op 应用到一个真的 PsdDoc 上。
 *
 * 这条路径以前一个测试都没有。tests/edit-pixels.test.ts 只断言 op 的形状，
 * doctype 侧的测试从来不喂 editPixels 产出的 op —— 于是
 * `validateAndNormalizeLayer` 拒绝惰性 PixelRef 这件事（每一次成功的
 * editPixels 都会在 apply() 里抛出 "layer.pixels must have numeric
 * width/height and a data buffer"）能一路活到评审。
 *
 * 所以这里尽量不用桩：真的 storePsdDoc、真的 runQuery、真的
 * createPsdDocumentType().apply —— op 从产出到落库走的是生产那条路。
 *
 * 三处替身，说清楚免得读者高估这条用例：ImageEditor 是桩（它背后是一次网络
 * 调用，不是本仓库的代码）；CAS 是内存实现 memCas；EffectContext 是这里手搓
 * 的，不是内核 AgentSession 建的那个。所以本用例**不覆盖** op 的 SValue
 * 编解码往返，也不覆盖 blob 的 root-ref 遍历。
 */
import { describe, expect, it } from "vitest";
import { decode } from "fast-png";
import { isSBlob, refsFromSValue } from "@unidocs/svalue-codec";
import type { EffectContext, SBlob, SBlobBytes, SValue } from "@unidocs/protocol";
import type { Layer, PsdDoc } from "../src/model/types.js";
import { createPsdDocumentType } from "../src/doctype.js";
import { materializePsdDoc, storePsdDoc, type PsdStoredDoc, type PsdStoredLayer } from "../src/state.js";
import { runQuery, type PsdQuery } from "../src/queries.js";
import { createEditPixelsTool } from "../src/image/edit-pixels.js";
import { createStubEditor } from "../src/testing/stub-editor.js";
import { memCas } from "./helpers/mem-cas.js";

const W = 64, H = 48;

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a; }
  return d;
}

const raster = (id: string, rgba: number[]): Layer => ({
  id, type: "raster", name: id, bounds: [0, 0, H, W], opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false,
  pixels: { width: W, height: H, data: fill(W, H, rgba) },
});

const doc = (): PsdDoc => ({
  canvas: { width: W, height: H, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [raster("bg", [0, 0, 0, 255]), raster("portrait", [10, 20, 30, 255])],
});

const findStored = (state: PsdStoredDoc, id: string): PsdStoredLayer => {
  const hit = state.layers.find(l => l.id === id);
  if (!hit) throw new Error(`layer ${id} not in stored doc`);
  return hit;
};

/** 真 EffectContext：query 走真的 runQuery，blob 读写走同一个 memCas。 */
function effectCtx(model: PsdDoc, cas: ReturnType<typeof memCas>): EffectContext<PsdQuery> {
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

async function editOnce(
  cas: ReturnType<typeof memCas>,
  state: PsdStoredDoc,
  instruction: string,
): Promise<{ next: PsdStoredDoc; layerId: string }> {
  const model = await materializePsdDoc(state, cas.ctx);
  const tool = createEditPixelsTool(createStubEditor());
  if (tool.kind !== "effect") throw new Error("editPixels must be an effect tool");
  const out = await tool.run({ layerId: "portrait", instruction }, effectCtx(model, cas));
  const sc = out.result.structuredContent as { ok?: boolean; layerId?: string; error?: string };
  if (sc.ok !== true) throw new Error(`editPixels failed: ${JSON.stringify(sc)}`);
  const dt = createPsdDocumentType(cas.ctx);
  return { next: await dt.apply(out.ops as never, state), layerId: sc.layerId! };
}

describe("editPixels 端到端：真 op 落到真 PsdDoc", () => {
  it("生成的 generative_fill op 能被真的 apply 接住，四项核心承诺都成立", async () => {
    const cas = memCas();
    const state0 = await storePsdDoc(doc(), cas.ctx);
    const srcHashBefore = findStored(state0, "portrait").pixels?.blob?.hash;
    expect(typeof srcHashBefore).toBe("string");

    // 真的 runQuery —— effect 拿到的就是这份结果。
    const model0 = await materializePsdDoc(state0, cas.ctx);
    const pixelsResult = await runQuery(
      { kind: "getLayerPixels", payload: { layerId: "portrait" } }, model0, cas.ctx,
    ) as unknown as { width: number; height: number; index: number; parentId: string | null };
    expect([pixelsResult.width, pixelsResult.height]).toEqual([W, H]);
    expect(pixelsResult.parentId).toBeNull();
    expect(pixelsResult.index).toBe(1);

    const { next: state1, layerId } = await editOnce(cas, state0, "删掉帽子");

    // (a) 结果层就在源层正上方：[bg, portrait, portrait-edit-…]
    expect(state1.layers.map(l => l.id)).toEqual(["bg", "portrait", layerId]);
    expect(layerId.startsWith("portrait-edit-")).toBe(true);

    // (b) 源层的字节没被动过 —— 非破坏的全部含义就在这一行
    expect(findStored(state1, "portrait").pixels?.blob?.hash).toBe(srcHashBefore);

    // (c) 结果层的 blob 真的在 CAS 里，且解码出源尺寸
    const resultBlob = findStored(state1, layerId).pixels?.blob;
    expect(resultBlob).toBeDefined();
    const handle = await cas.ctx.openSBlob(resultBlob!);
    expect(handle.contentType).toBe("image/png");
    const png = decode(await handle.readBytes({ offset: 0, length: handle.size }));
    expect([png.width, png.height]).toEqual([W, H]);

    // (d) 编辑之后 getPreview 还渲得出来 —— 惰性 PixelRef 没有把渲染打断
    const dt = createPsdDocumentType(cas.ctx);
    const preview = await dt.query({ kind: "getPreview" }, state1) as unknown as
      { image: SBlob; width: number; height: number };
    expect(preview.width).toBe(W);
    const previewHandle = await cas.ctx.openSBlob(preview.image);
    expect(previewHandle.size).toBeGreaterThan(0);
  });

  it("同一图层同一指令连编两次，两层都落得下 —— 层 id 不能只由内容决定", async () => {
    const cas = memCas();
    const state0 = await storePsdDoc(doc(), cas.ctx);
    const first = await editOnce(cas, state0, "删掉帽子");
    const second = await editOnce(cas, first.next, "删掉帽子");
    // 确定性 editor + 确定性输入 ⇒ 两次结果字节完全相同；若 id 取自内容
    // 哈希，第二次会撞上 "layer id already exists"。
    expect(second.layerId).not.toBe(first.layerId);
    // 每次都插在源层正上方，所以后编的那层压在先编的下面。
    expect(second.next.layers.map(l => l.id)).toEqual(["bg", "portrait", second.layerId, first.layerId]);
  });
});

/**
 * state.ts 有自己的一套显式白名单（PsdStoredDoc/JsonDoc 各建一次），跟
 * ir.ts 的 serialize/deserialize 是两层独立的收窄——ir.fonts 产出正确不代表
 * 这一层没把它筛掉。这里单独锁住 storePsdDoc/materializePsdDoc 这条 DO
 * 落库路径，尤其是 refsFromSValue 那条：前三条只证明"没丢"，这条证明
 * "钉住了"（CAS GC 靠它遍历 stored doc 找 blob 引用）。
 */
describe("storePsdDoc/materializePsdDoc：fonts 在 DO 持久化路径上的往返", () => {
  it("带 fonts 的文档往返之后 fonts 不丢，blob 能被 isSBlob 认出来", async () => {
    const cas = memCas();
    const fontBlob = await cas.ctx.makeSBlob({
      data: new TextEncoder().encode("fake-otf-bytes"),
      contentType: "font/otf",
    });
    const withFonts: PsdDoc = { ...doc(), fonts: [{ postScriptName: "NotoSansSC", blob: fontBlob }] };

    const state = await storePsdDoc(withFonts, cas.ctx);
    expect(state.fonts).toHaveLength(1);
    expect(state.fonts![0].postScriptName).toBe("NotoSansSC");
    expect(isSBlob(state.fonts![0].blob)).toBe(true);
    expect(state.fonts![0].blob.hash).toBe(fontBlob.hash);

    const model = await materializePsdDoc(state, cas.ctx);
    expect(model.fonts).toHaveLength(1);
    expect(model.fonts![0].postScriptName).toBe("NotoSansSC");
    expect(model.fonts![0].blob.hash).toBe(fontBlob.hash);
  });

  it("不带 fonts 的文档往返之后仍然不带这个属性（不是 undefined 值）", async () => {
    const cas = memCas();
    const state = await storePsdDoc(doc(), cas.ctx);
    expect("fonts" in state).toBe(false);

    const model = await materializePsdDoc(state, cas.ctx);
    expect("fonts" in model).toBe(false);
  });

  it("保活：storePsdDoc 产出的 stored doc 喂给 refsFromSValue 之后，字体的 hash 出现在结果里", async () => {
    const cas = memCas();
    const fontBlob = await cas.ctx.makeSBlob({
      data: new TextEncoder().encode("fake-otf-bytes"),
      contentType: "font/otf",
    });
    const withFonts: PsdDoc = { ...doc(), fonts: [{ postScriptName: "NotoSansSC", blob: fontBlob }] };

    const state = await storePsdDoc(withFonts, cas.ctx);
    const refs = refsFromSValue(state as unknown as SValue);
    expect(Object.keys(refs)).toContain(fontBlob.hash);
  });
});
