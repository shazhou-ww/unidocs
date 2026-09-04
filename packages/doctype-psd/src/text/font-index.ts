/**
 * `FontIndexSource` 的中立实现 —— 架在 Task 1 下沉的 `FontRegistry` 之上。
 *
 * 两个平台的接线（`cloudflare-psd/src/fonts-source.ts` 与
 * `azure-psd/src/agent-deps.ts`）除了"怎么拿到一个 `FontRegistry`"之外，其余
 * 逻辑逐字相同 —— 都是 `registry.list()` 拍平成按 postScriptName 索引的
 * `FontIndex`，外加一层 60 秒缓存。平台差异到此收敛成两个入参：`registry`
 * （怎么打后端：CF 是租户级字体 DO，Azure 是 `PgFontRegistry`）和 `blobFor`
 * （索引条目里的内容哈希怎么变成一个能交给 `ctx.readBlob` 的 `SBlob`）。
 */
import type { FontRegistry } from "@unidocs/doctype-server-common";
import type { SBlob } from "@unidocs/protocol";
import type { FontEntry, FontIndex } from "./registry.js";
import type { FontIndexSource } from "./set-text.js";

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

export interface FontIndexOptions {
  readonly registry: FontRegistry;
  /** 回退链，按优先级。请求的字体缺席、或者它不认识某个码位时逐个试。 */
  readonly fallbacks: readonly string[];
  /** 索引条目 → 可以读的 SBlob。字节在哪儿、怎么建这个引用由调用方决定
   *  （Cloudflare 传 `createSBlob`，Azure 传自己的），这一层不假设任何一种。 */
  readonly blobFor: (entry: FontEntry) => SBlob;
  /** 测试注入用；默认 `Date.now`。 */
  readonly now?: () => number;
}

export function createFontIndex(options: FontIndexOptions): FontIndexSource {
  const now = options.now ?? (() => Date.now());
  let cached: { at: number; index: Promise<FontIndex> } | null = null;

  const fetchIndex = async (): Promise<FontIndex> => {
    const entries = await options.registry.list();
    return new Map(entries.map(entry => [entry.postScriptName, entry]));
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
    blobFor: options.blobFor,
  };
}

/**
 * 回退链配置：`PSD_FONT_FALLBACKS="NotoSans,NotoSansSC"`，逗号分隔，顺序即
 * 优先级。
 *
 * 缺省是空数组，**不硬编码任何字体名**：硬编码一个 CAS 里可能不存在的名字，
 * 回退链只会静默失效 —— `resolveFaceChain` 对没装载的候选是直接跳过，不报错。
 *
 * 住在这里而不是某个平台包里，是因为两个平台读的是同一个环境变量、要的是同一
 * 套语义。它曾经只在 `cloudflare-psd` 里有一份；Azure 侧接线时若各写一份，
 * "逗号分隔、trim、丢空段"这几条迟早会分叉。
 */
export function parseFontFallbacks(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(",").map(name => name.trim()).filter(name => name.length > 0);
}
