/**
 * `FontIndexSource` 的 Cloudflare 接线 —— 把中立的 `createFontIndex`
 * （`@unidocs/doctype-psd`，架在 `FontRegistry` 之上，含 60 秒缓存）接到
 * 这个包自己的 `createDoFontRegistry`（打租户级字体 DO）与 `createSBlob`
 * （索引条目的内容哈希 → 可读的 SBlob）。
 *
 * 缓存那段不在这里 —— 已经下沉进 `createFontIndex`，两个平台共用，见
 * `doctype-psd/src/text/font-index.ts`。
 *
 * 它跑在 operator DO 里：打一次租户级字体 DO 拿索引，把索引里的内容哈希包成
 * 一个 `setText` 能交给 `ctx.readBlob` 的 SBlob。**字节不经它的手**（裁定
 * R29）—— 字节在 CAS，由 effect 自己带着会话身份去读。
 *
 * 这里产出的 SBlob 只用于读，不承担保活：保活是 `storePsdDoc` → `storeFont`
 * 用 `context.makeSBlob` 重新建立的（`doctype-psd` 的 `state.ts`）。
 */
import { createSBlob } from "@unidocs/cloudflare-sdk";
import { createFontIndex, type FontIndexSource } from "@unidocs/doctype-psd";
import { createDoFontRegistry } from "./font-registry-do.js";
import { fontsObjectName } from "./fonts-do.js";

export interface FontIndexSourceOptions {
  readonly namespace: DurableObjectNamespace;
  readonly stackId: string;
  readonly tenantId: string;
  readonly fallbacks: readonly string[];
  /** 测试注入用；默认 `Date.now`。 */
  readonly now?: () => number;
}

export function createFontIndexSource(options: FontIndexSourceOptions): FontIndexSource {
  const registry = createDoFontRegistry({
    namespace: options.namespace,
    objectName: fontsObjectName({ stackId: options.stackId, tenantId: options.tenantId }),
  });
  return createFontIndex({
    registry,
    fallbacks: options.fallbacks,
    blobFor: entry => createSBlob(entry.hash),
    now: options.now,
  });
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
