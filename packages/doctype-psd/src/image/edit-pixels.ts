import { decode, encode } from "fast-png";
import type { AgentTool, EffectContext, EffectOutcome, JsonValue, SBlob } from "@unidocs/protocol";
import type { Layer, Pixels } from "../model/types.js";
import type { PsdOp } from "../ops/index.js";
import type { PsdQuery } from "../queries.js";
import { downscale } from "../render/index.js";
import type { ImageEditor } from "./editor.js";
import { applyCoverageToAlpha, softenMask } from "./guards.js";

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

/**
 * `changed` 为 null 时的整层替换：既然连"哪块改了"都不可信，逐像素的 alpha
 * 更不可信（可能是源本来的半透明，也可能是模型的重采样噪声）——干脆整层
 * 铺满不透明，别把一份不可信的透明度带进文档。
 */
const forceOpaque = (px: Pixels): Pixels => {
  const data = new Uint8ClampedArray(px.data);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: px.width, height: px.height, data };
};

const fail = (structuredContent: JsonValue): EffectOutcome<PsdOp> =>
  ({ ops: [], result: { structuredContent } });

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
 * 全图蒙了一层不可见的偏色。烘进 alpha 之后，没动的那 97.7% 像素仍然是
 * 原层的原始字节。
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

      const { data } = await ctx.query({ kind: "getLayerPixels", payload: { layerId } } as never);
      const info = data as unknown as LayerPixelsResult;
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
      const landed = result.changed
        ? applyCoverageToAlpha(result.pixels, softenMask(result.changed, MASK_SOFTEN))
        : forceOpaque(result.pixels);

      const resultBlob = await ctx.writeBlob({
        data: pixelsToPng(landed),
        contentType: "image/png",
      });

      const layer: Record<string, unknown> = {
        id: `${layerId}-edit-${resultBlob.hash.slice(0, 8)}`,
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

      const provenance: Record<string, unknown> = {
        ...result.provenance,
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
        ops: [{ kind: "generative_fill", payload: { layer, parentId: info.parentId, index: info.index + 1, provenance } }] as never,
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
