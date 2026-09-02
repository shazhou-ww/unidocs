import { decode, encode } from "fast-png";
import { httpCallEvent, httpCallFailure, noopObserver, readObservedBody } from "@unidocs/protocol-doc";
import type { HttpCallInput, ObserveFn } from "@unidocs/protocol-doc";
import type { Pixels } from "../model/types.js";
import type { EditRequest, EditResult, EditorCapabilities, ImageEditor } from "./editor.js";
import { compositeOnSentinel, diffMask, fitPixelBudget, recoverAlpha, resample } from "./guards.js";

export interface QwenEditorOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** 测试注入用。不给就用全局 fetch。 */
  readonly fetch?: typeof fetch;
  /**
   * 每次对 DashScope 的调用记一条结构化事件（耗时、状态、失败时的完整栈）。
   *
   * 默认 noop，所以单测和既有调用方行为不变；composition root 注入
   * `consoleObserver`。这是系统里唯一的第三方调用，出问题时没有它就只能
   * 对着一个不透明的 500 猜 —— 那正是这个字段存在的理由。
   */
  readonly observe?: ObserveFn;
  /**
   * 单张图片编码后的字节上限。默认 {@link DEFAULT_MAX_IMAGE_BYTES}，即
   * DashScope 实测的 10MB 硬限制留 1MB 余量后的值。
   *
   * 可配是因为这是 provider 的**政策**而非物理常量：换 plan、换 provider、
   * 或对方哪天调整了，都不该要改代码。
   */
  readonly maxImageBytes?: number;
}

/**
 * 缺省模型。**换模型不用改代码** —— `model` 是个选项，composition root 从
 * `IMAGE_EDIT_MODEL` 传进来。实测 `wan2.6-image` 与它走同一个 endpoint、
 * 同一个请求体、同一个响应形状，所以同一套实现就够了。
 *
 * 同一张合成图（2048x1536 = 3.15 Mpx，带颗粒）上跑同一条指令，量未编辑区：
 *
 *                        输出分辨率              宽高比    颗粒 RMS   中位色偏
 *   原图（原生）          2048x1536  3.15 Mpx    1.3333     33.57       —
 *   qwen-image-edit-plus  1184x896   1.06 Mpx    1.3214      9.44    +2/+6/+6
 *   wan2.6-image          1472x1104  1.63 Mpx    1.3333     12.78    +2/ 0/-1
 *
 * 三点值得记住：
 *
 * 1. **分辨率天花板在模型里，不在我们这边。** 送 3.15 Mpx 回来只有 34% / 52%。
 *    wan2.6 多给 1.5 倍像素，宽高比还与输入精确一致（qwen 的 1.3214 意味着
 *    缩回 bounds 时有一次轻微拉伸）。
 * 2. **颗粒是模型抹掉的，不是降采样抹掉的。** 把原图纯降采样到同尺寸，颗粒
 *    还有 22.35 / 27.73；模型回来只剩 9.44 / 12.78。也就是说就算完全不降
 *    采样，它也不会还你颗粒 —— 它是重画的。想保住毛玻璃质感只能落地时自己补。
 * 3. **对照只测了"保留能力"。** 跑的是合成图上的"红方块变蓝"，只证明模型会
 *    执行指令，不证明它在人像上画得更好。生成质量没测过。
 */
const DEFAULT_MODEL = "qwen-image-edit-plus";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com";

/**
 * OpenAI 兼容端点**不能生图** —— `/compatible-mode/v1/images/generations` 和
 * `/images/edits` 实测都是 404 空体。生图只有原生 AIGC 这一条路。
 */
const GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation";

/**
 * 内容审核拒绝的 code。这类失败改措辞可能有救，与限流/网络故障要分开。
 *
 * 实测验证过的只有错误信封本身：`{code, message, request_id}` + HTTP 400 这个
 * 形状，是用一个故意写错的 model 名换来的（返回 `InvalidParameter` /
 * `Model not exist.`）。"DataInspectionFailed" 和 "ResponseTimeout.DataInspection"
 * 这两个具体值都没有真实触发过 —— 没有人为了拿到内容审核拒绝而故意提交过
 * 有问题的内容，这两个值纯粹来自文档。两者都留在集合里：就算文档写错了，
 * 误判的代价也只是在一条本来就会失败的路径上给错 reason，不会更糟。
 */
const REFUSAL_CODES = new Set(["DataInspectionFailed", "ResponseTimeout.DataInspection"]);

const encodePng = (px: Pixels): Uint8Array =>
  encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });

/** 已编码的 PNG 字节 → data URL。分成两步是因为字节预算那轮已经编过一次了，
 *  再编一遍纯属浪费（几 MB 的图上这不是小钱）。 */
const toDataUrl = (png: Uint8Array): string => {
  let s = "";
  for (const b of png) s += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(s)}`;
};

/**
 * DashScope 对**图片文件字节数**的硬限制是 10MB（实测：13.02MB 的 PNG 被
 * 400 拒绝，message 明写 "exceeds the maximum allowed size of 10MB"）。
 *
 * 注意这是字节预算，不是像素预算 —— PNG 的大小取决于内容熵。2048x2048 的
 * 合成渐变压出来不到 1MB，同尺寸的真实照片能到 13MB。所以只卡 maxPixels
 * 是拦不住的，必须编码后量真实字节再决定要不要继续缩。
 *
 * 这正是 queries.ts 的 PREVIEW_BASE64_BUDGET 早就写明的道理。留 1MB 余量。
 */
const DEFAULT_MAX_IMAGE_BYTES = 9 * 1000 * 1000;
/** 重编次数。每轮都量真实字节，按 sqrt(预算/实际) 收敛，3 次足够。 */
const MAX_ENCODE_ATTEMPTS = 3;

/**
 * 缩到编码后的 PNG 落进 `MAX_IMAGE_BYTES`。
 *
 * 为什么不换 JPEG（对照片小一个数量级）：哨兵底色和差异蒙版都依赖像素级
 * 精确。JPEG 的有损块效应会把哨兵色糊掉，alpha 还原判错；也会让未编辑区
 * 产生远超阈值 16 的噪声，差异蒙版直接失效。宁可缩小，不可有损。
 */
function fitEncodedBytes(px: Pixels, maxBytes: number): { px: Pixels; png: Uint8Array } {
  let current = px;
  let png = encodePng(current);
  for (let i = 0; i < MAX_ENCODE_ATTEMPTS && png.length > maxBytes; i++) {
    const scale = Math.sqrt(maxBytes / png.length) * 0.95;
    const width = Math.max(1, Math.floor(current.width * scale));
    const height = Math.max(1, Math.floor(current.height * scale));
    if (width >= current.width && height >= current.height) break; // 不收敛就别空转
    // 每轮都从**原图**缩，而不是从上一轮的结果再缩，避免重采样误差累积。
    current = resample(px, width, height);
    png = encodePng(current);
  }
  return { px: current, png };
}

const CAPABILITIES: EditorCapabilities = {
  // 指令式编辑，不吃蒙版。给了也没用，所以别为它算蒙版。
  mask: "unsupported",
  // 没观测到任何下限：实测 64x48 = 3072px 被原样接受，没有触发放大。
  // 设成 1 意味着 fitPixelBudget 的放大分支在本适配器里基本走不到 ——
  // 这是诚实的结果，不是要绕开它；guards.ts 里那个分支是共享代码，自己有测试。
  minPixels: 1,
  // 没有实测过的上限，纯粹是保守估计；唯一效果是触发缩小（安全方向），
  // 不是从任何一次真实调用里量出来的边界。
  maxPixels: 2048 * 2048,
  // 实测 parameters.watermark=false 时未编辑区色偏很小，远低于 diffMask 的
  // 阈值 16 —— 差异蒙版可信。两个模型都量过（见下面 DEFAULT_MODEL 的对照）。
  watermarked: false,
};

const toPixels = (png: Uint8Array): Pixels => {
  const img = decode(png);
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  const ch = img.channels;
  const src = img.data as ArrayLike<number>;
  // 模型回的是 RGB（3 通道）；也兼容它哪天回 RGBA。
  for (let i = 0; i < n; i++) {
    out[i * 4] = src[i * ch];
    out[i * 4 + 1] = src[i * ch + 1];
    out[i * 4 + 2] = src[i * ch + 2];
    out[i * 4 + 3] = ch === 4 ? src[i * ch + 3] : 255;
  }
  return { width: img.width, height: img.height, data: out };
};

/** 从响应里挖出结果图 URL。结构以 tests/fixtures/qwen-edit-response.json 为准。 */
function parseImageUrl(body: unknown): string | null {
  const choices = (body as { output?: { choices?: unknown[] } })?.output?.choices;
  if (!Array.isArray(choices)) return null;
  for (const choice of choices) {
    const content = (choice as { message?: { content?: unknown[] } })?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const image = (part as { image?: unknown })?.image;
      if (typeof image === "string" && image.length > 0) return image;
    }
  }
  return null;
}

/**
 * 包一层计时与事件上报。沿用 gateway-common 的写法：2xx 只记简报，>=400 才
 * 去读响应体，抛出来的（超时、连接被切）走 httpCallFailure，它会把 cause 和
 * 完整栈一起展开。
 *
 * 请求头一概不上报 —— 这条路上的 Authorization 带着 API key。
 */
async function observedFetch(
  doFetch: typeof fetch,
  observe: ObserveFn,
  input: Omit<HttpCallInput, "durationMs">,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const started = Date.now();
  try {
    const response = await doFetch(url, init);
    const finished = { ...input, durationMs: Date.now() - started };
    const detail = response.status >= 400 ? await readObservedBody(response.clone()) : undefined;
    observe(httpCallEvent(finished, response.status, detail));
    return response;
  } catch (err) {
    observe(httpCallFailure({ ...input, durationMs: Date.now() - started }, err));
    throw err;
  }
}

export function createQwenImageEditor(opts: QwenEditorOptions): ImageEditor {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = opts.fetch ?? fetch;
  const observe = opts.observe ?? noopObserver;
  const maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  return {
    id: model,
    capabilities: CAPABILITIES,

    async edit(req: EditRequest, signal: AbortSignal): Promise<EditResult> {
      const { source, instruction } = req;
      const seed = req.seed ?? 0;
      // 进来就已经 abort 的情况要自己挡：fetch 未必来得及抛，而契约套件
      // 明确要求"已经 abort 的 signal 不产生成功结果"。
      if (signal.aborted) return { ok: false, reason: "timeout", detail: "aborted before start" };
      try {
        // 坑 3：模型吃 RGB 吐 RGB，先把 alpha 编码进哨兵底色。
        const flattened = compositeOnSentinel(source);
        // 坑 1：先把尺寸压进 provider 的区间；回来还要缩回原尺寸。
        const fit = fitPixelBudget(
          flattened.width, flattened.height,
          CAPABILITIES.minPixels, CAPABILITIES.maxPixels,
        );
        const fitted = resample(flattened, fit.width, fit.height);
        // 像素预算之后还要过一道**字节预算** —— provider 卡的是文件大小，
        // 而 PNG 大小取决于内容熵，像素数管不住它（实测 13.02MB 被 400 拒）。
        const { png: sentPng } = fitEncodedBytes(fitted, maxImageBytes);

        const generationUrl = `${baseUrl}${GENERATION_PATH}`;
        const response = await observedFetch(doFetch, observe, {
          dir: "out", target: "dashscope", op: "generation", method: "POST", url: generationUrl,
        }, generationUrl, {
          method: "POST",
          signal,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: { messages: [{ role: "user", content: [{ image: toDataUrl(sentPng) }, { text: instruction }] }] },
            parameters: { watermark: false },
          }),
        });

        // 只把"读体时真的解析失败"降级成 {}；如果是 signal 在读体过程中才触发的
        // abort，必须让 AbortError 冒泡到外层 catch，否则会被误判成 provider_error。
        let body: unknown;
        try {
          body = await response.json();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          body = {};
        }
        if (!response.ok) {
          const code = String((body as { code?: unknown }).code ?? "");
          const detail = `${response.status} ${code}: ${String((body as { message?: unknown }).message ?? "")}`;
          return REFUSAL_CODES.has(code)
            ? { ok: false, reason: "refused", detail }
            : { ok: false, reason: "provider_error", detail };
        }

        const url = parseImageUrl(body);
        if (!url) {
          return { ok: false, reason: "provider_error", detail: `no image in response (request_id=${String((body as { request_id?: unknown }).request_id ?? "?")})` };
        }

        // OSS URL 约 24 小时后失效 —— 立刻下载，绝不存起来以后再取。
        const imageResponse = await observedFetch(doFetch, observe, {
          dir: "out", target: "dashscope", op: "result-download", method: "GET", url,
        }, url, { signal });
        if (!imageResponse.ok) {
          return { ok: false, reason: "provider_error", detail: `result download failed: ${imageResponse.status}` };
        }
        const returned = toPixels(new Uint8Array(await imageResponse.arrayBuffer()));

        // 坑 1 收尾：缩回源尺寸。所有实测的好指标都是在这一步之后测的，
        // 重采样噪声被 diffMask 的阈值吸收掉了。
        const back = resample(returned, source.width, source.height);
        // 坑 3 收尾：哨兵色判回透明 —— 这是适配器**尽力而为**的 alpha，不是
        // 最终答案。
        //
        // 它必然在轮廓边缘失手：模型会重采样，把哨兵品红和内容糊在一起，糊出来
        // 的中间色落在容差之外就被判成不透明。实测一个四周留透明的圆角矩形，
        // 该透明的 396741 个像素里 7613 个（1.9%）被判成不透明、全贴着轮廓，
        // 526 个抗锯齿软边像素全部被二值化（这条路只吐 0 或 255）。
        //
        // **要不要保住源的轮廓，是调用方的政策，不是适配器的事**（见
        // edit-pixels.ts 的 reshape）：同一份输出，重绘照片内容时该按源的
        // alpha 裁回去，换字体时反而必须用这里这份。所以适配器只负责交出
        // 模型这一侧的最佳估计。
        const pixels = recoverAlpha(back);

        // 后置条件：适配器的 bug 不许污染文档。
        if (pixels.width !== source.width || pixels.height !== source.height
          || pixels.data.length !== source.width * source.height * 4) {
          return { ok: false, reason: "provider_error", detail: "post-condition failed: output size mismatch" };
        }

        return {
          ok: true,
          pixels,
          // 差异必须在**同一个色彩空间**里比。`source` 的透明区带的是 PSD
          // 里的原 RGB（通常 0,0,0），而 recoverAlpha 之后的 `pixels` 透明区
          // 带的是适配器自己刷上去的哨兵品红 —— diffMask 跨四通道取最大值，
          // 拿这两者相比，每个透明像素都差 255，全被判成"改过"。透明比例
          // 高的抠图层因此会越过 MAX_CHANGED_FRACTION 退化成整层替换，正是
          // 蒙版本该拦住的色偏失败。`flattened` 与 `back` 都在哨兵空间、
          // 都是源尺寸，比它们才问得出"模型到底动了哪里"。
          //
          // （`flattened` 的 alpha 一定是 255，那是 compositeOnSentinel 的
          // 后置条件；`back` 的 alpha 则取决于 provider：本适配器面对的是
          // 只回 RGB 的模型，toPixels 于是补 255，但那条 ch===4 的分支说明
          // 这不是结构上的保证。真回了 alpha 的 provider 会让这里多算出一些
          // 差异 —— 保守方向，不会漏判改动区。）
          changed: CAPABILITIES.watermarked ? null : diffMask(flattened, back),
          provenance: { model, seed, prompt: instruction },
        };
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        return aborted
          ? { ok: false, reason: "timeout", detail: String(err) }
          : { ok: false, reason: "provider_error", detail: String(err) };
      }
    },
  };
}
