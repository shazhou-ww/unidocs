import { decode, encode } from "fast-png";
import { isSBlob } from "@unidocs/svalue-codec";
import type { AgentTool, EffectContext, EffectOutcome, JsonValue, SBlob, SValueType } from "@unidocs/protocol";
import type { Pixels } from "../model/types.js";
import type { PsdOp } from "../ops/index.js";
import type { PsdQuery } from "../queries.js";
import { downscale } from "../render/index.js";
import type { ImageEditor } from "./editor.js";
import { applyCoverageToAlpha, resample, softenMask, unmixSentinel } from "./guards.js";

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
  /** 源层的合成属性，见 queries.ts 里 getLayerPixels 的注释。 */
  clipping: boolean;
  blendMode: string;
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
 * 模型想画到源轮廓**之外**的像素占源透明区的比例。
 *
 * 只在 reshape=false 时有意义：这些像素刚刚被按源的 alpha 裁掉了。比例高就
 * 说明模型试图改轮廓，而调用方说了不改 —— 多半是 reshape 漏了。把这件事说
 * 出来，"换字体得到一个新旧字形交叠的畸形物"才有可能被自己发现并纠正，而不
 * 是静默交付。
 */
function clippedOutsideShape(model: Pixels, source: Pixels): number {
  let outside = 0, transparent = 0;
  for (let i = 3; i < source.data.length; i += 4) {
    if (source.data[i] !== 0) continue;
    transparent++;
    if (model.data[i] > 0) outside++;
  }
  return transparent === 0 ? 0 : outside / transparent;
}

/**
 * 超过这个比例就提醒模型 reshape 可能漏了。
 *
 * **选定值，不是实测值。** 下限不能是 0：适配器那份 alpha 本身就有约 1.9% 的
 * 沿轮廓误判（实测），拿 0 当阈值等于每次都报警。0.15 把"边缘噪声"和"模型
 * 真的在轮廓外画了东西"分开，量级上留了近十倍余量。真实文档上跑过之后该重定。
 */
const RESHAPE_HINT_FRACTION = 0.15;

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
  if (typeof d!.clipping !== "boolean") bad("clipping is not a boolean");
  if (typeof d!.blendMode !== "string") bad("blendMode is not a string");
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
        reshape: {
          type: "boolean",
          description:
            "Set true ONLY when the edit changes the layer's SHAPE — the outline of its non-transparent "
            + "pixels. Re-lettering in a different font, reshaping a cut-out, adding a glow or outline that "
            + "extends past the current edges: those change the shape. Repainting content INSIDE the existing "
            + "outline (swapping a hat inside a photo, recolouring, removing an object) does NOT. "
            + "Irrelevant when the layer is fully opaque — getPreview reports alpha(opaque=...); at 1 there is "
            + "no outline to preserve or change. When true the source layer is HIDDEN, because otherwise its "
            + "old shape shows through from underneath (two fonts at once). Default false, which keeps the "
            + "source layer's exact outline, anti-aliased edges included, and leaves the source visible.",
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
      const reshape = args.reshape === true;

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

      // ——— 轮廓政策 ———
      //
      // 适配器交回来的 alpha 是它从模型输出里**猜**的（哨兵回收），只吐 0 或
      // 255，而且在轮廓边缘会失手：实测一个四周留透明的圆角矩形，该透明的像素
      // 里 1.9% 被判成不透明、全贴着轮廓，落地就是沿边一圈毛边、四周透不出去；
      // 526 个抗锯齿软边像素还全部被二值化。
      //
      // 而源的 alpha 是**精确已知**的。所以默认按源裁回去 —— editPixels 重绘的
      // 是图层内部的内容，轮廓是图层的属性。
      //
      // 但这不能无条件做：轮廓本来就该变的编辑（换字体、重塑抠图、加发光），
      // 按旧轮廓裁回去会把新字形切成新旧交叠的畸形物。那种情况只能用模型这份
      // alpha，边缘糙一点也远好过被裁掉 —— 由调用方用 `reshape` 声明，因为
      // 这两种意图从像素里分不出来（试过 max(源, 模型)：那 1.9% 的误判会被
      // 原样保留，毛边立刻回来）。
      // reshape=false:轮廓由源说了算,所以 alpha 直接用源的 —— 而既然 alpha 已知,
      // 哨兵底色就能**精确**地从 RGB 里除掉(unmixSentinel)。只换 alpha 不除底色
      // 会把品红留在每一条抗锯齿边上:实测一张文字层空跑一趟,边缘平均色差 61.46。
      const shaped = reshape ? result.pixels : unmixSentinel(result.pixels, source);

      // 差异蒙版烘进结果层自己的 alpha：未改动的区域全透明，下面的原层
      // 原样露出来。这一步就是"把模型带来的全局色偏关在改动区里"的全部机制 ——
      // 没它，整层无遮挡地盖上去等于给全图蒙一层不可见的偏色。
      const masked = result.changed
        ? applyCoverageToAlpha(shaped, softenMask(result.changed, MASK_SOFTEN))
        : shaped;

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

      // id 的判别位来自现有同源结果层里**最大的那个序号**加一，不来自内容
      // —— 见 nextEditOrdinal。取最大值而不是取数量：中间那层被删掉之后，
      // 数量会退回去撞上还活着的编号。所以确定性 editor 连编两次也不撞 id。
      const { data: layerTree } = await ctx.query({ kind: "getLayers" });
      const idPrefix = `${layerId}-edit-`;
      const layer: Record<string, unknown> = {
        id: `${idPrefix}${nextEditOrdinal(layerTree, idPrefix)}`,
        type: "raster",
        name: `${instruction.slice(0, 24)}`,
        bounds: info.bounds,
        // opacity 是 1、而不是源层的 opacity：孤立渲染已经把它乘进 alpha 了
        // （composite.ts 的 compositeBuffer 收 layer.opacity），再带一次就是
        // 乘两遍。mask 与图层效果同理，都已经烘进像素。
        opacity: 1,
        visible: true,
        locked: false,
        // 这两个必须跟着源层走。**clipping 在孤立渲染里根本不存在** ——
        // renderLayer 渲的是只有这一层的文档，剪裁基底不在场，所以拿到的是
        // 没被剪裁的整层。一张被剪进圆角矩形的照片，结果层若不跟着标 clipping，
        // 落回文档就会越过那个圆角框铺满自己的 bounds，圆角和上下边距一起消失。
        //
        // 插在源层正上方是安全的：renderList 的 baseCoverage 在连续的 clipping
        // 层之间保持不变（只有遇到非 clipping 层才重置），所以结果层用的是与
        // 源层同一个基底。源层被 reshape 隐藏时也一样 —— 隐藏分支只在
        // `!layer.clipping` 时清掉基底。
        clipping: info.clipping,
        // blendMode 没被烘进像素：孤立渲染的背景是透明的，混合模式在那儿无效。
        blendMode: info.blendMode,
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

      // reshape=false 时，模型画到轮廓外的部分刚刚被裁掉了。裁得多就说明
      // 它本来想改轮廓 —— 提醒一次，比静默交付一个被切碎的结果强。
      const clipped = reshape ? 0 : clippedOutsideShape(result.pixels, source);
      const reshapeNote = clipped > RESHAPE_HINT_FRACTION
        ? ` NOTE: the model painted over ${(clipped * 100).toFixed(0)}% of this layer's transparent area, and`
          + ` all of it was clipped away to keep the layer's existing outline. If this edit was meant to change`
          + ` the SHAPE (different font, reshaped cut-out, added glow), removeLayer "${layer.id as string}" and`
          + ` retry with reshape: true.`
        : "";

      return {
        // bottom-to-top 数组：源层 index + 1 就是它的正上方。
        // 这个断言是**必需**的，不是懒：`PsdOp.payload` 是
        // `Record<string, unknown>`，`unknown` 不满足 SValueShape，于是
        // `SValueType<PsdOp>` 求值成 `never`，任何 op 字面量都赋不进去。
        // tools.ts 的 psdOp() 出于同一个原因用同一个写法。相比之下，
        // ctx.query 上原来那个 `as never` 是多余的：PsdQuery 里本来就有
        // getLayerPixels，已经删掉。
        ops: [
          {
            kind: "generative_fill",
            payload: { layer, parentId: info.parentId, index: info.index + 1, provenance },
          },
          // 改轮廓时必须把源层藏起来，否则旧轮廓从下面透出来 —— 换字体会得到
          // 两种字体并存，重塑抠图会得到新旧两个形状。用 visible:false 而不是
          // removeLayer：像素一个字节没动，用户在图层面板里点回来就恢复，也照样
          // 进版本历史可以回滚。
          //
          // 两个 op 在同一次 apply 里，所以"新层出现"和"源层隐藏"落在同一个
          // 版本上，中间不存在一个两者都可见的中间态。
          ...(reshape
            ? [{ kind: "set_props", payload: { layerId, props: { visible: false } } }]
            : []),
        ] as unknown as readonly SValueType<PsdOp>[],
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
              // "The original layer is untouched" 在 reshape 时是假的 —— 它被
              // 隐藏了。像素确实一个字节没动，但画面上它不见了，模型必须知道
              // 这件事才可能在做错时把它恢复回来。
              text: (result.changed
                ? `Done. Result landed as layer "${layer.id as string}" above ${layerId}, transparent outside the changed region.`
                : `Done, but the change covered the whole layer, so no mask was derived — the result replaces the source layer's appearance entirely. Landed as "${layer.id as string}".`)
                + (reshape
                  ? ` Because reshape was set, the source layer "${layerId}" is now HIDDEN so its old outline cannot show through — setProps visible:true to bring it back.`
                  : ` The original layer is unchanged and still visible underneath.`)
                + reshapeNote,
            },
          ],
        },
      };
    },
  };
}
