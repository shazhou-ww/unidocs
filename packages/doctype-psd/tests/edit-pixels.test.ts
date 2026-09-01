import { describe, expect, it, vi } from "vitest";
import { encode, decode } from "fast-png";
import { createSBlob } from "@unidocs/svalue-codec";
import type { EffectContext, SBlob, SBlobBytes } from "@unidocs/protocol";
import { createEditPixelsTool } from "../src/image/edit-pixels.js";
import { createStubEditor } from "../src/testing/stub-editor.js";
import type { PsdQuery } from "../src/queries.js";

const SRC_W = 64, SRC_H = 48;

function sourcePng(): Uint8Array {
  const data = new Uint8ClampedArray(SRC_W * SRC_H * 4).fill(200);
  return encode({ width: SRC_W, height: SRC_H, data, channels: 4, depth: 8 });
}

/** 假 EffectContext：query 回一份 getLayerPixels 结果，blob 存在 Map 里。 */
function fakeCtx(over: { queryResult?: Record<string, unknown> } = {}) {
  const blobs = new Map<string, SBlobBytes>();
  const srcHash = "1".repeat(64);
  blobs.set(srcHash, { data: sourcePng(), contentType: "image/png" });
  let n = 0;
  const written: SBlobBytes[] = [];
  const ctx: EffectContext<PsdQuery> & { blobs: typeof blobs; written: typeof written } = {
    blobs, written,
    query: vi.fn(async () => ({
      data: over.queryResult ?? {
        image: createSBlob(srcHash),
        width: SRC_W, height: SRC_H,
        bounds: [10, 20, 10 + SRC_H, 20 + SRC_W],
        parentId: "g1", index: 2,
      },
      version: 7,
    })) as never,
    readBlob: vi.fn(async (b: SBlob) => blobs.get(b.hash)!),
    writeBlob: vi.fn(async (d: SBlobBytes): Promise<SBlob> => {
      written.push(d);
      const hash = String(n++).padStart(64, "f");
      blobs.set(hash, d);
      return createSBlob(hash);
    }),
    signal: AbortSignal.timeout(10_000),
  };
  return ctx;
}

describe("editPixels effect", () => {
  it("产出一个 generative_fill op，结果层插在源层正上方（index+1）", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    const out = await tool.run({ layerId: "portrait", instruction: "删掉帽子" }, ctx);
    expect(out.ops).toHaveLength(1);
    const op = out.ops[0] as unknown as { kind: string; payload: Record<string, any> };
    expect(op.kind).toBe("generative_fill");
    expect(op.payload.parentId).toBe("g1");
    // 图层数组是 bottom-to-top，所以"正上方"= 源层 index + 1
    expect(op.payload.index).toBe(3);
  });

  it("结果层的 bounds 与源层完全一致 —— 非破坏叠加要对齐", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, fakeCtx());
    const layer = (out.ops[0] as any).payload.layer;
    expect(layer.bounds).toEqual([10, 20, 10 + SRC_H, 20 + SRC_W]);
    expect(layer.type).toBe("raster");
  });

  it("像素以 PixelRef 落地，不把 RGBA 塞进 op —— 整层 RGBA 会撑爆 delta", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, ctx);
    const layer = (out.ops[0] as any).payload.layer;
    expect(layer.pixels).toMatchObject({ width: SRC_W, height: SRC_H });
    expect(typeof layer.pixels.hash).toBe("string");
    expect(layer.pixels.data).toBeUndefined();
    // 写进 CAS 的第一份是结果 PNG，尺寸等于源尺寸
    const png = decode(ctx.written[0].data);
    expect([png.width, png.height]).toEqual([SRC_W, SRC_H]);
  });

  it("差异蒙版烘进结果层的 alpha —— 未改动区域全透明，原层照样露出来", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    await tool.run({ layerId: "portrait", instruction: "x" }, ctx);
    // 桩 editor 只改左上 1/4，其余区域覆盖度为 0
    const png = decode(ctx.written[0].data);
    const rgba = png.data as ArrayLike<number>;
    const ch = png.channels;
    const idx = (x: number, y: number) => (y * SRC_W + x) * ch;
    expect(rgba[idx(4, 4) + 3]).toBe(255);          // 改动区：不透明
    expect(rgba[idx(SRC_W - 4, SRC_H - 4) + 3]).toBe(0); // 未改动区：透明
  });

  it("provenance 原样带进 op", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "portrait", instruction: "删掉帽子" }, fakeCtx());
    expect((out.ops[0] as any).payload.provenance).toMatchObject({
      model: "stub-editor", prompt: "删掉帽子",
    });
    // seed 不进 op：editPixels 从不给 editor 传 seed，适配器也从不把它发给
    // provider，记一个默认 0 等于承诺一份拿不出的可复现性。
    expect((out.ops[0] as any).payload.provenance.seed).toBeUndefined();
  });

  it("返回一张 after 预览图，省掉模型再调一次 getPreview", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, fakeCtx());
    const image = out.result.content?.find(p => p.type === "image");
    expect(image).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("editor 拒绝时 ops 为空，原因回给模型 —— 不落 op、不 bump 版本", async () => {
    const tool = createEditPixelsTool(
      createStubEditor({ fail: { ok: false, reason: "refused", detail: "内容审核未通过" } }),
    );
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, ctx);
    expect(out.ops).toEqual([]);
    expect(out.result.structuredContent).toMatchObject({
      ok: false, reason: "refused", detail: "内容审核未通过",
    });
    expect(ctx.writeBlob).not.toHaveBeenCalled();
  });

  it("changed 为 null 时降级整层替换：alpha 原样透传，不经过蒙版裁剪；provenance 标 maskDerivation none", async () => {
    const editor = createStubEditor();
    const noMask = {
      ...editor,
      edit: async (req: any, sig: AbortSignal) => {
        const r = await editor.edit(req, sig);
        return r.ok ? { ...r, changed: null } : r;
      },
    };
    const tool = createEditPixelsTool(noMask);
    if (tool.kind !== "effect") throw new Error("kind");
    const ctx = fakeCtx();
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, ctx);
    const payload = (out.ops[0] as any).payload;
    expect(payload.provenance.maskDerivation).toBe("none");
    const png = decode(ctx.written[0].data);
    const ch = png.channels;
    const corner = (png.data as ArrayLike<number>)[((SRC_H - 1) * SRC_W + SRC_W - 1) * ch + 3];
    // changed 为 null 时没有蒙版可用，直接透传 editor 返回的像素——不拉高、
    // 不裁剪。sourcePng() 用 fill(200) 填出全通道（含 alpha）都是 200 的
    // 夹具，桩 editor 只改写左上 1/4，右下角保留原样，所以这里应该是
    // 源本身的 200，既不是被裁到 0，也不是被强行拉到 255。
    expect(corner).toBe(200);

    // 对照组：同一个桩 editor，走正常的蒙版路径（changed 非 null）时，
    // 同一个角落覆盖度为 0，applyCoverageToAlpha 把它乘成 0。两条分支在
    // 同一角落给出不同答案，才真正区分开"没走蒙版"和"走了蒙版且结果碰巧
    // 不透明"——单看一个常数分不出这两种情况。
    const maskedTool = createEditPixelsTool(createStubEditor());
    if (maskedTool.kind !== "effect") throw new Error("kind");
    const maskedCtx = fakeCtx();
    await maskedTool.run({ layerId: "portrait", instruction: "x" }, maskedCtx);
    const maskedPng = decode(maskedCtx.written[0].data);
    const maskedCh = maskedPng.channels;
    const maskedCorner = (maskedPng.data as ArrayLike<number>)[((SRC_H - 1) * SRC_W + SRC_W - 1) * maskedCh + 3];
    expect(maskedCorner).toBe(0);
  });

  it("query 按预算缩过图时，结果层被缩回 bounds 的真实尺寸", async () => {
    // getLayerPixels 返回一张 64x48 的图，但 bounds 说这层其实是 256x192。
    // 结果层要盖在源层身上，所以落盘的像素必须正好铺满 bounds，否则合成器
    // 会把一张小图错位地贴在大图层的位置上。
    const ctx = fakeCtx({
      queryResult: {
        image: createSBlob("1".repeat(64)),
        width: SRC_W, height: SRC_H,
        bounds: [10, 20, 10 + SRC_H * 4, 20 + SRC_W * 4],
        parentId: "g1", index: 2,
      },
    });
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ layerId: "portrait", instruction: "x" }, ctx);

    const layer = (out.ops[0] as any).payload.layer;
    expect([layer.pixels.width, layer.pixels.height]).toEqual([SRC_W * 4, SRC_H * 4]);
    // 落进 CAS 的字节也真的是放大后的，不是"报了个大尺寸、写了张小图"
    const png = decode(ctx.written[0].data);
    expect([png.width, png.height]).toEqual([SRC_W * 4, SRC_H * 4]);
    // bounds 原样透传
    expect(layer.bounds).toEqual([10, 20, 10 + SRC_H * 4, 20 + SRC_W * 4]);
  });

  it("把下游能吃多少像素告诉 getLayerPixels —— 别让 Editor 编一张白编的大图", async () => {
    const ctx = fakeCtx();
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    await tool.run({ layerId: "portrait", instruction: "x" }, ctx);
    expect(ctx.query).toHaveBeenCalledWith({
      kind: "getLayerPixels",
      payload: { layerId: "portrait", maxPixels: createStubEditor().capabilities.maxPixels },
    });
  });

  it("参数缺失时以 result 报错，不抛", async () => {
    const tool = createEditPixelsTool(createStubEditor());
    if (tool.kind !== "effect") throw new Error("kind");
    const out = await tool.run({ instruction: "x" }, fakeCtx());
    expect(out.ops).toEqual([]);
    expect(String((out.result.structuredContent as any).error)).toMatch(/layerId/);
  });
});
