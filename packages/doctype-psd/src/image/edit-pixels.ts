import { decode, encode } from "fast-png";
import { isSBlob } from "@unidocs/svalue-codec";
import type { AgentTool, EffectContext, EffectOutcome, JsonValue, SBlob, SValueType } from "@unidocs/protocol";
import type { Pixels } from "../model/types.js";
import type { PsdOp } from "../ops/index.js";
import type { PsdQuery } from "../queries.js";
import { downscale } from "../render/index.js";
import type { ImageEditor } from "./editor.js";
import { applyCoverageToAlpha, resample, softenMask } from "./guards.js";

/** 回给模型看的 after 预览的长边上限。和 getPreview 的默认值一致。 */
const AFTER_PREVIEW_MAX_SIZE = 768;
/** 差异蒙版的软化参数：先向外推 2px 盖住重采样毛边，再羽化 2px 出过渡带。 */
const MASK_SOFTEN = { dilate: 2, feather: 2 } as const;

interface LayerPixelsResult {
  image: SBlob;
  width: number;
  height: number;
  bounds: [number, number, number, number];
  parentId: string | null;
  index: number;
}

const pngToPixels = (png: Uint8Array): Pixels => {
  const img = decode(png);
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  const ch = img.channels;
  const src = img.data as ArrayLike<number>;
  for (let i = 0; i < n; i++) {
    data[i * 4] = src[i * ch];
    data[i * 4 + 1] = src[i * ch + 1];
    data[i * 4 + 2] = src[i * ch + 2];
    data[i * 4 + 3] = ch === 4 ? src[i * ch + 3] : 255;
  }
  return { width: img.width, height: img.height, data };
};

const pixelsToPng = (px: Pixels): Uint8Array =>
  encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });

const fail = (structuredContent: JsonValue): EffectOutcome<PsdOp> =>
  ({ ops: [], result: { structuredContent } });

/**
 * getLayerPixels 的返回值是 SValue，静态类型上什么都不是。以前这里是一个
 * 直接的 `as unknown as LayerPixelsResult` —— 而 C1（校验器拒绝惰性
 * PixelRef）就藏在这条缝里：类型断言让编译器闭嘴，运行期的形状错误要等到
 * 下游某个地方才炸，且炸出来的信息与真正的原因无关。这里改成显式检查，
 * 一旦 query 的形状变了就当场报出来。
 *
 * 抛异常而不是返回 fail()：这是内部契约被破坏，不是模型能改措辞绕开的失败。
 */
function asLayerPixels(data: unknown): LayerPixelsResult {
  const d = data as Record<string, unknown> | null;
  const bad = (what: string): never => {
    throw new Error(`editPixels: getLayerPixels returned an unexpected shape (${what})`);
  };
  if (!d || typeof d !== "object") bad("not an object");
  if (!isSBlob(d!.image)) bad("image is not an SBlob");
  if (typeof d!.width !== "number" || typeof d!.height !== "number") bad("width/height are not numbers");
  const bounds = d!.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(n => typeof n === "number")) {
    bad("bounds is not four numbers");
  }
  if (d!.parentId !== null && typeof d!.parentId !== "string") bad("parentId is neither string nor null");
  if (typeof d!.index !== "number") bad("index is not a number");
  return d as unknown as LayerPixelsResult;
}

/**
 * 结果层 id 的判别位：扫出文档里已有的 `${layerId}-edit-N`，取最大 N + 1。
 *
 * 不能用内容哈希 —— 同一图层跑同一条指令、editor 又是确定性的，第二次会
 * 产出同样的哈希，`addLayer` 抛 "layer id already exists"。也不能用时钟或
 * 随机数：这个值要进 op，而 apply 必须能确定性重放。
 */
function nextEditOrdinal(layers: unknown, prefix: string): number {
  let max = 0;
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const l = item as { id?: unknown; children?: unknown } | null;
      if (l && typeof l.id === "string" && l.id.startsWith(prefix)) {
        const n = Number(l.id.slice(prefix.length));
        if (Number.isInteger(n) && n > max) max = n;
      }
      walk(l?.children);
    }
  };
  walk(layers);
  return max + 1;
}

/**
 * `editPixels` —— 图层内部像素的唯一入口。
 *
 * 为什么必须是 effect：其余所有写工具都要求调用方在 JSON 参数里交出 RGBA
 * 数组，而 LLM 产不出像素。图层操作快，正是因为它们的参数是数字和字符串。
 *
 * 落地形态是**新的 raster 图层**，插在源层正上方，不覆盖源层。差异蒙版
 * 烘进这个新层自己的 alpha 通道：改动区不透明，其余区域全透明，下面的原层
 * 原样露出来。
 *
 * 这个蒙版不是可有可无的修饰。模型返回的是整层重绘，未编辑区域也被重画了
 * 一遍；实测色偏虽小（-1.94/-1.62/+0.52），但整层无遮挡地盖上去就等于给
 * 全图蒙了一层不可见的偏色。烘进 alpha 之后，覆盖度为 0 的区域这一层完全
 * 透明，露出的就是原层的原始字节；只有改动区和它周围那圈羽化过渡带里的
 * 像素来自模型。改动占比越小，被重绘的面积就越小。
 *
 * 为什么不用真正的图层蒙版（Mask）：见 guards.ts 的 applyCoverageToAlpha。
 */
export function createEditPixelsTool(editor: ImageEditor): AgentTool<PsdQuery, PsdOp> {
  return {
    kind: "effect",
    name: "editPixels",
    description:
      "WRITE. Repaint the pixels INSIDE one layer from a plain-language instruction "
      + "(remove / replace / add an object). The result lands as a NEW layer directly above "
      + "the source layer, transparent outside the changed region, so the original layer is untouched. "
      + "This is the ONLY way to change pixels — layer ops cannot do it.",
    inputSchema: {
      type: "object",
      properties: {
        layerId: { type: "string", description: "The layer whose pixels to repaint." },
        instruction: {
          type: "string",
          description: "What to change, in plain language, e.g. \"remove the red hat from the person's head\".",
        },
      },
      required: ["layerId", "instruction"],
    },

    async run(args, ctx: EffectContext<PsdQuery>): Promise<EffectOutcome<PsdOp>> {
      const layerId = args.layerId;
      const instruction = args.instruction;
      if (typeof layerId !== "string" || layerId.length === 0) {
        return fail({ error: "editPixels: layerId must be a non-empty string" });
      }
      if (typeof instruction !== "string" || instruction.length === 0) {
        return fail({ error: "editPixels: instruction must be a non-empty string" });
      }

      // 告诉 Editor 我们下游最多用得到多少像素：适配器拿到手第一件事就是把它
      // 压进这个区间，所以让 Editor 编一张全分辨率 PNG 是纯浪费，而且那份
      // 浪费落在一个 128 MiB 的 isolate 里。
      const { data } = await ctx.query({
        kind: "getLayerPixels",
        payload: { layerId, maxPixels: editor.capabilities.maxPixels },
      });
      const info = asLayerPixels(data);
      const sourceBytes = await ctx.readBlob(info.image);
      const source = pngToPixels(sourceBytes.data);

      const result = await editor.edit({ source, instruction }, ctx.signal);
      if (!result.ok) {
        // 失败是一次普通的工具返回，不是异常：不写文档、不涨版本，
        // 模型收到一段可读文本，自己决定改措辞重试还是换个做法。
        return fail({ ok: false, reason: result.reason, detail: result.detail });
      }

      // 差异蒙版烘进结果层自己的 alpha：未改动的区域全透明，下面的原层
      // 原样露出来。这一步就是"把模型带来的全局色偏关在改动区里"的全部机制 ——
      // 没它，整层无遮挡地盖上去等于给全图蒙一层不可见的偏色。
      const masked = result.changed
        ? applyCoverageToAlpha(result.pixels, softenMask(result.changed, MASK_SOFTEN))
        : result.pixels;

      // 结果层要盖在源层身上，所以它的像素必须正好铺满源层的 bounds。
      // getLayerPixels 可能按 maxPixels 缩过（见那边的注释），这里缩回去。
      // 这一步不损失信息：适配器内部本来就已经把图压进 maxPixels 再送模型，
      // 返回时也是从那个尺寸放大回来的，缩放只是换了发生的位置。
      const boundsWidth = info.bounds[3] - info.bounds[1];
      const boundsHeight = info.bounds[2] - info.bounds[0];
      const landed = masked.width === boundsWidth && masked.height === boundsHeight
        ? masked
        : resample(masked, boundsWidth, boundsHeight);

      const resultBlob = await ctx.writeBlob({
        data: pixelsToPng(landed),
        contentType: "image/png",
      });

      // id 的判别位来自"已有多少个同源结果层"，不来自内容 —— 见
      // nextEditOrdinal。所以确定性 editor 连编两次也不会撞 id。
      const { data: layerTree } = await ctx.query({ kind: "getLayers" });
      const idPrefix = `${layerId}-edit-`;
      const layer: Record<string, unknown> = {
        id: `${idPrefix}${nextEditOrdinal(layerTree, idPrefix)}`,
        type: "raster",
        name: `${instruction.slice(0, 24)}`,
        bounds: info.bounds,
        opacity: 1,
        blendMode: "normal",
        visible: true,
        locked: false,
        clipping: false,
        // PixelRef，不是 Pixels：一个整层 RGBA 是几十 MB，塞进 delta 会把
        // 版本日志撑爆。字节已经在 CAS 里，op 只带引用。
        pixels: { width: landed.width, height: landed.height, hash: resultBlob.hash, blob: resultBlob },
      };

      // seed 被刻意丢掉：editPixels 从不给 editor 传 seed，适配器于是也
      // 从不把 seed 发给 provider —— 记下来的那个 0 不是"重跑能复现的种子"，
      // 而是一个默认值。把它写进文档就是在承诺一份我们拿不出的可复现性。
      const { seed: _unusedSeed, ...editorProvenance } = result.provenance;
      const provenance: Record<string, unknown> = {
        ...editorProvenance,
        // changed 为 null 时降级整层替换，把这件事记在案上 —— 将来查
        // "为什么这张图整体偏了一点"时，这一行就是答案。
        ...(result.changed ? {} : { maskDerivation: "none" }),
      };

      // after 预览：模型看得见自己改成了什么，省掉一次显式 getPreview。
      const preview = downscale(landed, AFTER_PREVIEW_MAX_SIZE);
      const previewBlob = await ctx.writeBlob({
        data: pixelsToPng(preview),
        contentType: "image/png",
      });

      return {
        // bottom-to-top 数组：源层 index + 1 就是它的正上方。
        // 这个断言是**必需**的，不是懒：`PsdOp.payload` 是
        // `Record<string, unknown>`，`unknown` 不满足 SValueShape，于是
        // `SValueType<PsdOp>` 求值成 `never`，任何 op 字面量都赋不进去。
        // tools.ts 的 psdOp() 出于同一个原因用同一个写法。相比之下，
        // ctx.query 上原来那个 `as never` 是多余的：PsdQuery 里本来就有
        // getLayerPixels，已经删掉。
        ops: [{
          kind: "generative_fill",
          payload: { layer, parentId: info.parentId, index: info.index + 1, provenance },
        }] as unknown as readonly SValueType<PsdOp>[],
        description: `editPixels(${layerId}): ${instruction}`,
        result: {
          structuredContent: {
            ok: true,
            layerId: layer.id as string,
            bounds: info.bounds as unknown as JsonValue,
            masked: result.changed !== null,
            model: result.provenance.model,
          },
          content: [
            { type: "image", blob: previewBlob, mediaType: "image/png", altText: `after: ${instruction}` },
            {
              type: "text",
              text: result.changed
                ? `Done. Result landed as layer "${layer.id as string}" above ${layerId}, transparent outside the changed region. The original layer is untouched.`
                : `Done, but the change covered the whole layer, so no mask was derived — the result replaces the source layer's appearance entirely. Landed as "${layer.id as string}".`,
            },
          ],
        },
      };
    },
  };
}
