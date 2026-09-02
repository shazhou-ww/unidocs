import type { PsdDoc, Layer } from "./model/types.js";
import type { QueryValue, DocumentTypeContext } from "@unidocs/protocol";
import { encode } from "fast-png";
import { renderCached, renderRegion, renderLayer, downscale, DEFAULT_CACHE_BYTES, type RenderCtx } from "./render/index.js";
import { PixelCache } from "./render/pixel-source.js";
import type { DocRenderState } from "./render/doc-render-state.js";
import { casBlobStore } from "./psd/cas-blobstore.js";
import { findLayer, findParentList, findParentId } from "./model/tree.js";
import { fitPixelBudget, resample } from "./image/guards.js";

export type PsdQuery =
  | { kind: "getLayers"; payload?: Record<string, never> }
  | { kind: "getDoc"; payload?: { layerId?: string } }
  | { kind: "getPreview"; payload?: { rect?: [number, number, number, number]; layerId?: string; maxSize?: number } }
  | { kind: "getLayerPixels"; payload: { layerId: string; maxPixels?: number } };

function summarize(l: Layer): any {
  return {
    id: l.id, type: l.type, name: l.name ?? "",
    opacity: l.opacity ?? 1, blendMode: l.blendMode ?? "normal",
    visible: l.visible ?? true, bounds: l.bounds ?? [0, 0, 0, 0],
    ...(l.children ? { children: l.children.map(summarize) } : {}),
  };
}

/** Deep-copy a layer with pixel/mask data stripped (keep dimensions + metadata). */
function stripLayer(l: Layer): any {
  const { pixels, mask, children, ...rest } = l;
  return {
    ...rest,
    ...(pixels ? { pixels: { width: pixels.width, height: pixels.height, omitted: true } } : {}),
    ...(mask ? { mask: { bounds: mask.bounds, defaultColor: mask.defaultColor, inverted: mask.inverted, pixels: { width: mask.pixels.width, height: mask.pixels.height, omitted: true } } } : {}),
    ...(children ? { children: children.map(stripLayer) } : {}),
  };
}

/**
 * Budget for the encoded PNG, expressed in BASE64-EQUIVALENT bytes — despite
 * the "byte budget" framing, `fitToBudget` below compares against
 * `b64Length(png.length)` (what the PNG's size would be if base64-encoded),
 * not `png.length` itself. That formula predates the move to SBlob and is
 * left as-is rather than reworked, so the real ceiling on PNG bytes is
 * tighter than this constant reads: roughly `PREVIEW_BASE64_BUDGET * 3/4` ≈
 * 720 KiB, not 960 KiB.
 *
 * The PNG itself now travels as a CAS-backed SBlob, not an inline base64
 * string, so it no longer risks the codec's 1 MiB `maxStringBytes` cap. The
 * budget stays for a different reason: this PNG also gets handed to the
 * model as an image content part, and a multi-megabyte image is wasted
 * context — expensive to transfer, expensive to look at, and no more
 * informative past a certain resolution. Capping the ENCODED BYTES (rather
 * than a fixed dimension) is still the right lever, because size depends on
 * content, not pixel count: PNG cannot beat raw RGBA on detailed imagery, so
 * a dimension cap alone would force an unreasonably small universal ceiling.
 */
const PREVIEW_BASE64_BUDGET = 960 * 1024;
/** Never shrink a preview below this; past here it stops being informative. */
const MIN_PREVIEW_SIZE = 64;
/** Re-encode attempts. Each pass measures real bytes, so 3 is ample. */
const MAX_FIT_ATTEMPTS = 3;

/**
 * `getLayerPixels` 硬拒绝的像素数上限。
 *
 * 这个值原本是 16M（4096x4096），注释里写着"一个 DO isolate 扛得住的天花板
 * 就在这附近" —— 那是推的，没测过。实际账目：Editor DO 常驻一个
 * DEFAULT_CACHE_BYTES = 64 MiB 的像素缓存预算（composite.ts:56），而一个
 * workerd isolate 上限 128 MiB。16M 像素光解码后的 RGBA 就是 64 MiB，再加
 * 编码缓冲，必然把 isolate 挤爆 —— 而 isolate 被内存杀掉时不产生 JS 异常，
 * 排查时只能看到一个不透明的 internal error。
 *
 * 8M 像素 = 32 MiB RGBA，给 64 MiB 缓存之外留出了余量。渲染本身很快
 * （实测 16.8M 像素 render+encode 合计 792ms），瓶颈从来是内存不是 CPU。
 */
const MAX_EDIT_SOURCE_PIXELS = 8 * 1024 * 1024;

type Px = { width: number; height: number; data: Uint8ClampedArray };

const b64Length = (byteLength: number): number => Math.ceil(byteLength / 3) * 4;
const longestSide = (px: Px): number => Math.max(px.width, px.height);

function pngOf(px: Px): Uint8Array {
  return encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });
}

/**
 * Downscale to `maxSize`, then keep shrinking until the base64 fits
 * {@link PREVIEW_BASE64_BUDGET}.
 *
 * Each pass re-derives the target from the bytes actually measured — encoded
 * size is roughly proportional to pixel count, so scaling the longest side by
 * `sqrt(budget / actual)` lands close on the first retry — and every pass
 * downscales from the ORIGINAL pixels rather than from the previous (already
 * point-sampled) result, so repeated fitting cannot compound resampling
 * artefacts.
 */
function fitToBudget(source: Px, maxSize: number): { px: Px; png: Uint8Array } {
  let px = downscale(source, maxSize);
  let png = pngOf(px);
  for (let i = 0; i < MAX_FIT_ATTEMPTS && b64Length(png.length) > PREVIEW_BASE64_BUDGET; i++) {
    const side = longestSide(px);
    if (side <= MIN_PREVIEW_SIZE) break;
    const ratio = Math.sqrt(PREVIEW_BASE64_BUDGET / b64Length(png.length)) * 0.95;
    const next = Math.max(MIN_PREVIEW_SIZE, Math.floor(side * ratio));
    if (next >= side) break; // not converging — stop rather than spin
    px = downscale(source, next);
    png = pngOf(px);
  }
  return { px, png };
}

function requireCtx(ctx: DocumentTypeContext | undefined, operation: string): DocumentTypeContext {
  if (!ctx) throw new Error(`${operation} needs a DocumentTypeContext to store the rendered PNG`);
  return ctx;
}

/**
 * 透明度统计。比例，保留三位小数。
 *
 * 存在的理由是实测出来的：**模型看不见透明。** 把同一个图形分别放在全透明
 * 背景和真实黑底上交给 operator 模型，它把透明那张读成"白色背景"，而且因为
 * 图形本身是白的，它连图形都没看见 —— 原话是"白色图形在白色背景上而几乎
 * 不可见"；黑底那张它描述得一清二楚。
 *
 * 所以凡是"这一层有没有透明""透明占多少"的判断，都不能让模型去看图，得把
 * 数字给它。`opaque + transparent + soft === 1`。
 */
export interface AlphaStats {
  /** alpha === 255 的比例。为 1 就是一张实心矩形，透明相关的判断全部不适用。 */
  readonly opaque: number;
  /** alpha === 0 的比例。 */
  readonly transparent: number;
  /** 0 < alpha < 255 的比例 —— 抗锯齿软边、半透明笔触。 */
  readonly soft: number;
}

/** 从**降采样之前**的像素上数，所以是精确值，不受预览缩放影响。 */
export function alphaStats(px: Px): AlphaStats {
  const n = px.width * px.height;
  let opaque = 0, transparent = 0;
  for (let i = 3; i < px.data.length; i += 4) {
    const a = px.data[i];
    if (a === 255) opaque++;
    else if (a === 0) transparent++;
  }
  const r = (v: number) => Math.round((v / n) * 1000) / 1000;
  return { opaque: r(opaque), transparent: r(transparent), soft: r(n - opaque - transparent) };
}

/** Photoshop 那种灰白棋盘格的方块边长（预览像素）。 */
const CHECKER_SIZE = 8;
const CHECKER_LIGHT = 255;
const CHECKER_DARK = 204; // #CCC，与 Photoshop 的透明底一致

/**
 * 把带透明的预览合成到灰白棋盘格上，返回不透明的 RGBA。
 *
 * 不是装饰。模型收到的是 PNG，而它的视觉管线会把 alpha 压平 —— 实测压成了
 * **白色**。于是一个白色 logo 或白色标题字放在透明图层上，`getPreview{layerId}`
 * 交给模型的就是一片空白，它会以为那层是空的。棋盘格同时解决两件事：浅色
 * 内容重新可见，且这个花纹本身就是"这里是透明"的通用视觉约定。
 *
 * 只在真的有透明像素时才铺 —— 实心图层铺了纯属给模型添乱。
 */
function overCheckerboard(px: Px): Px {
  const out = new Uint8ClampedArray(px.data);
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const o = (y * px.width + x) * 4;
      const a = out[o + 3] / 255;
      if (a === 1) continue;
      const bg = ((x / CHECKER_SIZE | 0) + (y / CHECKER_SIZE | 0)) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK;
      for (let c = 0; c < 3; c++) out[o + c] = out[o + c] * a + bg * (1 - a);
      out[o + 3] = 255;
    }
  }
  return { width: px.width, height: px.height, data: out };
}

/** PNG-encode and hand out an SBlob reference; no more base64 (spec 5.3, 2.4). */
async function toImageResult(
  source: Px,
  region: [number, number, number, number],
  maxSize: number,
  ctx: DocumentTypeContext,
): Promise<QueryValue> {
  // 统计取自**原始**像素，不是降采样后的：降采样会把软边抹匀，比例就不准了。
  const alpha = alphaStats(source);
  // 棋盘格铺在降采样**之后**，方块才是恒定的视觉大小；也因此要重新编码。
  // 全不透明时整条路都跳过 —— 不多花一次遍历、一次编码。
  const fitted = fitToBudget(source, maxSize);
  const px = alpha.opaque === 1 ? fitted.px : overCheckerboard(fitted.px);
  const png = alpha.opaque === 1 ? fitted.png : pngOf(px);
  const image = await ctx.makeSBlob({ data: png, contentType: "image/png" });
  return { image, width: px.width, height: px.height, region, alpha } as unknown as QueryValue;
}

export async function runQuery(
  q: PsdQuery,
  doc: PsdDoc,
  ctx?: DocumentTypeContext,
  render?: DocRenderState,
): Promise<QueryValue> {
  switch (q.kind) {
    case "getLayers":
      return doc.layers.map(summarize);

    case "getDoc": {
      const layerId = q.payload?.layerId;
      const layers = layerId
        ? (() => { const l = findLayer(doc.layers, layerId); if (!l) throw new Error(`layer not found: ${layerId}`); return [l]; })()
        : doc.layers;
      return { canvas: doc.canvas, layers: layers.map(stripLayer) } as unknown as QueryValue;
    }

    case "getPreview": {
      const p = q.payload ?? {};
      // Absent maxSize → a token-thrifty ceiling for the agent's eye.
      // An explicit maxSize (e.g. the viewer asking for full-res) is honored
      // as-is; downscale never upscales, so it's a no-op when already smaller.
      const cap = p.rect ? 1536 : 768;
      const maxSize = p.maxSize ?? cap;
      // With a `render` state (an Editor DO, which keeps one per document),
      // previews go through its resident compositor: decoded pixels stay warm
      // across requests and an edit only invalidates the tiles its dirty rect
      // covers. Byte-identical to the stateless path below — see
      // tests/doc-render-state.test.ts, which pins `composite`/`region`
      // against `render`/`renderRegion` across edits, rollback and eviction.
      //
      // Without one (resident docs, direct callers, tests) this falls back to
      // the original stateless path verbatim: a fresh PixelCache per call, and
      // the resident entrypoints' own defaultCtx() when there is no `ctx`.
      const rc: RenderCtx | undefined = render
        ? render.ctx
        : ctx
          ? { store: casBlobStore(ctx), cache: new PixelCache(DEFAULT_CACHE_BYTES) }
          : undefined;
      let px: { width: number; height: number; data: Uint8ClampedArray };
      let region: [number, number, number, number];
      if (p.layerId) {
        const l = findLayer(doc.layers, p.layerId);
        if (!l) throw new Error(`layer not found: ${p.layerId}`);
        // A single-layer preview renders an ISOLATED one-layer document, which
        // shares no tiles with this document — but it does share blobs, so it
        // still takes the warm decoded-pixel cache via `rc`.
        px = await renderLayer(doc, p.layerId, {}, rc);
        region = l.bounds;
      } else if (p.rect) {
        // `renderRegion` composites the whole canvas and then crops; the
        // tile-backed path composites only the tiles the rect touches.
        px = render ? await render.region(doc, p.rect) : await renderRegion(doc, p.rect, rc);
        region = p.rect;
      } else {
        px = render ? await render.composite(doc) : await renderCached(doc, rc);
        region = [0, 0, doc.canvas.height, doc.canvas.width];
      }
      return toImageResult(px, region, maxSize, requireCtx(ctx, "getPreview"));
    }

    case "getLayerPixels": {
      // 和 getPreview{layerId} 渲的是同一张图（renderLayer：孤立的单层文档，
      // 蒙版与图层效果已烘进去），区别只有一个：**不过 fitToBudget**。
      // 预览是给模型的眼睛看的，压到 768 正合适；编辑要的是原始像素，压了
      // 就再也还原不回去。
      const { layerId, maxPixels } = q.payload;
      const l = findLayer(doc.layers, layerId);
      if (!l) throw new Error(`layer not found: ${layerId}`);
      const w = l.bounds[3] - l.bounds[1];
      const h = l.bounds[2] - l.bounds[0];
      if (w * h > MAX_EDIT_SOURCE_PIXELS) {
        throw new Error(`layer ${layerId} is too large to edit: ${w}x${h} > ${MAX_EDIT_SOURCE_PIXELS} px`);
      }
      const c = requireCtx(ctx, "getLayerPixels");
      const rc: RenderCtx | undefined = render
        ? render.ctx
        : { store: casBlobStore(c), cache: new PixelCache(DEFAULT_CACHE_BYTES) };
      const rendered = await renderLayer(doc, layerId, {}, rc);
      // 调用方（effect）会告诉我们它下游真正用得到多少像素。编一张它拿到手
      // 第一件事就是缩小的全分辨率 PNG，只是白白抬高 Editor 的编码峰值和
      // Operator 的解码峰值 —— 两边都在 128 MiB 的 isolate 里。
      // `bounds` 仍然是图层的真实位置，调用方据此把结果缩回原尺寸。
      const px = maxPixels && rendered.width * rendered.height > maxPixels
        ? (() => {
          const fit = fitPixelBudget(rendered.width, rendered.height, 1, maxPixels);
          return resample(rendered, fit.width, fit.height);
        })()
        : rendered;
      const image = await c.makeSBlob({ data: pngOf(px), contentType: "image/png" });
      return {
        image,
        width: px.width,
        height: px.height,
        bounds: l.bounds,
        parentId: findParentId(doc.layers, layerId),
        index: findParentList(doc.layers, layerId)?.index ?? 0,
        // 源层的**合成属性**。结果层要盖在源层身上，就得按同样的方式参与合成。
        //
        // `clipping` 是这里最要紧的一个，因为它在孤立渲染里根本不存在：
        // renderLayer 渲的是一个只有这一层的文档，剪裁的基底不在场，所以
        // `rendered` 是**没被剪裁**的整层。一张被剪进圆角矩形的照片，从这里
        // 拿到的是完整的方角照片；结果层若不跟着标 clipping，落回文档就会
        // 越过那个圆角框铺满自己的 bounds —— 圆角和边距一起消失。
        //
        // `blendMode` 同理：孤立渲染的背景是透明的，混合模式在那里没有效果，
        // 所以它没被烘进像素，必须显式带过去。
        //
        // 不带的：opacity / fillOpacity 已经烘进孤立渲染的 alpha 了（见
        // composite.ts 的 compositeBuffer 调用），再带一次就是乘两遍；
        // mask 与图层效果同样已经烘进像素。
        clipping: l.clipping === true,
        blendMode: l.blendMode,
      } as unknown as QueryValue;
    }
  }
}
