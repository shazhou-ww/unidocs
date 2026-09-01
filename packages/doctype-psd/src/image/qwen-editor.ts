import { decode, encode } from "fast-png";
import type { Pixels } from "../model/types.js";
import type { EditRequest, EditResult, EditorCapabilities, ImageEditor } from "./editor.js";
import { compositeOnSentinel, diffMask, fitPixelBudget, recoverAlpha, resample } from "./guards.js";

export interface QwenEditorOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** 测试注入用。不给就用全局 fetch。 */
  readonly fetch?: typeof fetch;
}

const DEFAULT_MODEL = "qwen-image-edit-plus";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com";

/**
 * OpenAI 兼容端点**不能生图** —— `/compatible-mode/v1/images/generations` 和
 * `/images/edits` 实测都是 404 空体。生图只有原生 AIGC 这一条路。
 */
const GENERATION_PATH = "/api/v1/services/aigc/multimodal-generation/generation";

/**
 * 内容审核拒绝的 code。这类失败改措辞可能有救，与限流/网络故障要分开。
 * "DataInspectionFailed" 是实测拿到的（用一个必然触发审核的指令换来的响应体）；
 * "ResponseTimeout.DataInspection" 只是文档里写的，从没在真实调用里见过 —— 两者
 * 都留着，但别把后者当成验证过的事实。
 */
const REFUSAL_CODES = new Set(["DataInspectionFailed", "ResponseTimeout.DataInspection"]);

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
  // 实测 parameters.watermark=false 时未编辑区色偏 -1.94/-1.62/+0.52，
  // 远低于 diffMask 的阈值 16 —— 差异蒙版可信。
  watermarked: false,
};

const toDataUrl = (px: Pixels): string => {
  const png = encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });
  let s = "";
  for (const b of png) s += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(s)}`;
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

export function createQwenImageEditor(opts: QwenEditorOptions): ImageEditor {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = opts.fetch ?? fetch;

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
        const sent = resample(flattened, fit.width, fit.height);

        const response = await doFetch(`${baseUrl}${GENERATION_PATH}`, {
          method: "POST",
          signal,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: { messages: [{ role: "user", content: [{ image: toDataUrl(sent) }, { text: instruction }] }] },
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
        const imageResponse = await doFetch(url, { signal });
        if (!imageResponse.ok) {
          return { ok: false, reason: "provider_error", detail: `result download failed: ${imageResponse.status}` };
        }
        const returned = toPixels(new Uint8Array(await imageResponse.arrayBuffer()));

        // 坑 1 收尾：缩回源尺寸。所有实测的好指标都是在这一步之后测的，
        // 重采样噪声被 diffMask 的阈值吸收掉了。
        const back = resample(returned, source.width, source.height);
        // 坑 3 收尾：哨兵色判回透明。
        const pixels = recoverAlpha(back);

        // 后置条件：适配器的 bug 不许污染文档。
        if (pixels.width !== source.width || pixels.height !== source.height
          || pixels.data.length !== source.width * source.height * 4) {
          return { ok: false, reason: "provider_error", detail: "post-condition failed: output size mismatch" };
        }

        return {
          ok: true,
          pixels,
          changed: CAPABILITIES.watermarked ? null : diffMask(source, pixels),
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
