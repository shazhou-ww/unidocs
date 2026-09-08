/**
 * 字体来源的内部 SPI。
 *
 * **它不是外层概念** —— 外层（setText、路由、接线）只认 `FontRegistry` 那个门面。
 * 把 provider 数组交给外层，外层就会开始依赖它的顺序和成员，将来加第四种来源
 * （系统字体目录、字体 CDN）要改的地方会散开。
 */
import { createSBlob } from "@unidocs/svalue-codec";
import type { SBlob } from "@unidocs/protocol";
import type { FontEntry } from "./font-registry.js";

/**
 * effect 侧的读字节能力。
 *
 * 收窄成一个字段而不是把整个 `EffectContext` 拖进中立契约：这里只需要读 blob，
 * 而 `EffectContext` 还带着 query / makeSBlob 一大串跟字体无关的东西。
 * `EffectContext` 结构上满足它，调用方直接传 `ctx` 即可。
 */
export interface FontIo {
  readonly readBlob: (blob: SBlob) => Promise<{ data: Uint8Array }>;
}

export interface FontProvider {
  /** 稳定标识（"builtin" / "tenant"）。它会进索引条目的 `source` ——
   *  排查"为什么这个字用的不是我装的那套"时唯一的抓手。 */
  readonly id: string;

  /** 这个来源提供哪些字体。只返回元数据，不读字节。 */
  list(): Promise<readonly FontEntry[]>;

  /** 取字节。`entry` 必须是本来源自己 `list` 出来的那一条。
   *  CAS 来源要用 `io.readBlob` 带着会话身份去读，内置来源忽略 `io`。 */
  read(entry: FontEntry, io: FontIo): Promise<Uint8Array>;

  /** 这条要不要被文档钉住。CAS 来源返回 SBlob（`doc.fonts` 靠它保活），
   *  内置来源返回 null —— 字节随包走，没有可回收的对象。 */
  blobFor(entry: FontEntry): SBlob | null;
}

/**
 * 可写的来源。作用域是 (stackId, tenantId)，跨会话存活；适配器构造时绑定这两段
 * 身份，所以方法签名里没有它们。
 */
export interface WritableFontProvider extends FontProvider {
  /** 幂等：同一个 postScriptName 重登记覆盖旧的一条，不是报冲突 ——
   *  预置脚本每次跑都会把配置里的全套字体登记一遍。
   *
   *  今天只有租户那一档实现它（`POST /tenants/{t}/fonts` 与
   *  `scripts/seed-psd-fonts.mjs` 靠它）；内置来源不实现 —— 字节随包走，装不进去。
   *  门面的 `FontRegistry.install` 将来就路由到这里。 */
  put(entry: FontEntry): Promise<void>;
}

/**
 * CAS 来源的读取语义。两个平台**逐字相同** —— `createSBlob` 住在中立的
 * `@unidocs/svalue-codec`，两个平台 SDK 只是再导出它，这里没有任何平台差异。
 *
 * 抽出来不是为了少写八行，是为了让"两边一致"不依赖两个人各自记得。它**不是**
 * 一个存储层抽象：平台各自实现的仍然是完整的 `WritableFontProvider`，只是把这
 * 两个成员摊开来复用。
 */
export const casFontBytes = {
  /** 字节在 CAS，由跑在编辑会话里的 effect 带着会话身份去读（裁定 R29）。 */
  read: async (entry: FontEntry, io: FontIo): Promise<Uint8Array> =>
    (await io.readBlob(createSBlob(entry.hash))).data,
  blobFor: (entry: FontEntry): SBlob => createSBlob(entry.hash),
} as const;
