/**
 * `FontIndexSource` 的 Cloudflare 实现 —— `setText` 的字体来源。
 *
 * 它跑在 operator DO 里：打一次租户级字体 DO 拿索引，把索引里的内容哈希包成
 * 一个 `setText` 能交给 `ctx.readBlob` 的 SBlob。**字节不经它的手**（裁定
 * R29）—— 字节在 CAS，由 effect 自己带着会话身份去读。
 *
 * 这里产出的 SBlob 只用于读，不承担保活：保活是 `storePsdDoc` → `storeFont`
 * 用 `context.makeSBlob` 重新建立的（`doctype-psd` 的 `state.ts`）。
 */
import { createSBlob } from "@unidocs/cloudflare-sdk";
import type { FontEntry, FontIndex, FontIndexSource } from "@unidocs/doctype-psd";
import { FONTS_INTERNAL_PATH, fontsObjectName } from "./fonts-do.js";

/**
 * 索引缓存的存活时长。
 *
 * `setText` 每调用一次就 `load()` 一次，而索引是预置脚本写进去的、几乎不变
 * —— 每次排版前多打一次 DO 纯属浪费。反过来，永久缓存会让"新登记一套字体"
 * 在所有已经热起来的 operator DO 里都看不见，直到实例被回收，而 operator DO
 * 是跨请求存活的（对话历史在里面）。一分钟的上限把这个窗口关掉，代价是每分钟
 * 至多多打一次 DO。
 */
const INDEX_TTL_MS = 60_000;

export interface FontIndexSourceOptions {
  readonly namespace: DurableObjectNamespace;
  readonly stackId: string;
  readonly tenantId: string;
  readonly fallbacks: readonly string[];
  /** 测试注入用；默认 `Date.now`。 */
  readonly now?: () => number;
}

export function createFontIndexSource(options: FontIndexSourceOptions): FontIndexSource {
  const now = options.now ?? (() => Date.now());
  const objectName = fontsObjectName({ stackId: options.stackId, tenantId: options.tenantId });
  let cached: { at: number; index: Promise<FontIndex> } | null = null;

  const fetchIndex = async (): Promise<FontIndex> => {
    const stub = options.namespace.get(options.namespace.idFromName(objectName));
    const response = await stub.fetch(`http://psd-fonts${FONTS_INTERNAL_PATH}`, { method: "GET" });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Font index request failed ${response.status}: ${detail || response.statusText}`);
    }
    const body = await response.json() as { fonts?: unknown };
    if (!Array.isArray(body.fonts)) {
      throw new Error("Font index response has no fonts array");
    }
    return new Map((body.fonts as FontEntry[]).map(entry => [entry.postScriptName, entry]));
  };

  return {
    load: () => {
      if (cached && now() - cached.at < INDEX_TTL_MS) return cached.index;
      // 缓存的是 Promise 而不是结果：一个 operator DO 里并发的两次 setText
      // 只该打一次 DO。失败不留在缓存里 —— 否则一次网络抖动会被整整记住一个
      // TTL，期间每次 setText 都拿同一个 rejected promise。
      const index = fetchIndex();
      const entry = { at: now(), index };
      cached = entry;
      index.catch(() => {
        if (cached === entry) cached = null;
      });
      return index;
    },
    fallbacks: options.fallbacks,
    blobFor: entry => createSBlob(entry.hash),
  };
}

/**
 * 回退链配置：`PSD_FONT_FALLBACKS="NotoSans,NotoSansSC"`，逗号分隔，顺序即
 * 优先级。
 *
 * 缺省是空数组，**不硬编码任何字体名**：硬编码一个 CAS 里可能不存在的名字，
 * 回退链只会静默失效 —— `resolveFaceChain` 对没装载的候选是直接跳过，不报错。
 */
export function parseFontFallbacks(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(",").map(name => name.trim()).filter(name => name.length > 0);
}
