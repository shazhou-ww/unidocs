/**
 * 租户级字体登记表 —— 跨平台契约。
 *
 * **为什么不在 ports.ts 里**:那个模块的文件头写着"Every port in this module
 * is scoped to one Doc session",四个 port 全部经 SessionDeps 喂给
 * DocumentSession,身份是含 sessionId 的 SessionIdentity。字体索引是租户级
 * 的 —— 一个租户一套字体、被名下所有文档共用 —— 而且它永远不进
 * SessionDeps(消费者是路由处理器和 agent 依赖)。放进去它会是那个文件里唯一
 * 没有消费者的接口,并且当场作废那句不变式。
 *
 * 它**只存元数据,绝不碰 CAS**(裁定 R29):字节由预置脚本写进 CAS、由跑在
 * 编辑会话里的 setText effect 读,两边都拿得到会话身份;而租户级的登记表
 * 天然没有 sessionId,拿不到。
 */
import type { SBlob } from "@unidocs/protocol";
import type { FontIo, FontProvider } from "./font-provider.js";

/** 覆盖的码位区间,合并后按起点升序排列,区间之间不重叠也不相邻。 */
export type FontCoverage = readonly (readonly [number, number])[];

export interface FontEntry {
  readonly postScriptName: string;
  readonly family: string;
  /** 这份字体字节的内容哈希。**不代表它在 CAS 里** —— 内置字体的字节随包走，
   *  同样有合法的哈希。"在不在 CAS 里"由 provider 的 `blobFor()` 回答。 */
  readonly hash: string;
  /**
   * 从字体文件**解析**出来的,不是登记时人工填的。
   *
   * **排版不读这个字段** —— layoutText / rasterizeGlyphs 用的都是
   * face.unitsPerEm,即渲染时从字节现解析的值。这里这份是给运维看的
   * (登记了什么、对不对得上),改坏它不会影响任何输出。
   * 早先这条注释写的是"填错了字还是那些字、位置全错" —— 那是错的,
   * 而且误导了一轮测试补强:注入"写死 1000"之后全绿的真正原因不是测试字体
   * 的 upm 恰好都是 1000,是**这个字段本来就没有可观测后果**。family 同理。
   */
  readonly unitsPerEm: number;
  readonly coverage: FontCoverage;
}

/** createSBlob 只收 64 位小写十六进制;登记时就挡住,别留到 setText 才炸。 */
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CODE_POINT = 0x10ffff;

/**
 * 校验一条登记载荷。合法返回 null,否则返回**说得出哪一条不对**的原因。
 *
 * coverage 的形状是硬要求,不是洁癖:selectFonts(doctype-psd 的
 * text/registry.ts)用二分查找判一个码位有没有被覆盖,喂给它一个乱序或重叠的
 * 区间数组,查找会**静默返回错的结果** —— 那个字被判成"这套字体不认识",然后
 * 掉到回退链上,没有任何东西会报错。写入侧是唯一挡得住的地方。
 */
export function fontEntryProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "font entry must be a JSON object";
  }
  const entry = value as Record<string, unknown>;
  for (const field of ["postScriptName", "family", "hash"] as const) {
    const text = entry[field];
    if (typeof text !== "string" || text.length === 0) {
      return `${field} must be a non-empty string`;
    }
  }
  if (!HASH_PATTERN.test(entry.hash as string)) {
    return "hash must be 64 lowercase hexadecimal characters (a CAS content hash)";
  }
  const unitsPerEm = entry.unitsPerEm;
  if (typeof unitsPerEm !== "number" || !Number.isInteger(unitsPerEm) || unitsPerEm <= 0) {
    return `unitsPerEm must be a positive integer, got ${JSON.stringify(unitsPerEm)}`;
  }
  return coverageProblem(entry.coverage);
}

function coverageProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "coverage must be an array of [start, end] ranges";
  if (value.length === 0) {
    // 一套什么都不覆盖的字体永远不会被 `selectFonts` 选中,登记它只会得到一条
    // 谁也发现不了的死条目。这只可能是解析出错。
    return "coverage must not be empty";
  }
  // -2 让第一个区间的 start(≥ 0)必然通过下面 `start > previousEnd + 1` 那一关。
  let previousEnd = -2;
  for (let index = 0; index < value.length; index++) {
    const range: unknown = value[index];
    if (!Array.isArray(range) || range.length !== 2) {
      return `coverage[${index}] must be a [start, end] pair, got ${JSON.stringify(range)}`;
    }
    const [start, end] = range as unknown[];
    if (!isCodePoint(start) || !isCodePoint(end)) {
      return `coverage[${index}] must be two code points in [0, 0x10FFFF], got ${JSON.stringify(range)}`;
    }
    if (start > end) {
      return `coverage[${index}] is reversed: start ${start} is greater than end ${end}`;
    }
    if (start <= previousEnd + 1) {
      return `coverage[${index}] starts at ${start}, but coverage[${index - 1}] ends at ${previousEnd}`
        + " — ranges must be ascending, non-overlapping, and merged (adjacent ranges must be one)";
    }
    previousEnd = end;
  }
  return null;
}

function isCodePoint(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_CODE_POINT;
}

/** 索引里的一条。`source` 是 provider id：冲突解决之后，这条到底来自哪个来源。 */
export interface RegisteredFont {
  readonly entry: FontEntry;
  readonly source: string;
}

export type FontIndex = ReadonlyMap<string, RegisteredFont>;

/**
 * 字体的门面 —— **外层唯一要认识的东西**。字体从哪来、同名冲突谁赢、字节怎么取、
 * 装到哪儿，全部收在实现里。
 */
export interface FontRegistry {
  /** 合成、去冲突之后的索引，按 postScriptName。带 TTL 缓存。 */
  index(): Promise<FontIndex>;

  /** 取字节。内部按这条的来源分发。
   *  收 `RegisteredFont` 而不是名字：调用方本来就是从 `index()` 里取出来的，
   *  收名字就要在这里再查一次索引 —— 而索引是异步的，同步的 `blobFor` 查不了。 */
  read(font: RegisteredFont, io: FontIo): Promise<Uint8Array>;

  /** 这条要不要被文档钉住。转发给它的来源。 */
  blobFor(font: RegisteredFont): SBlob | null;

  /**
   * 装一套字体：内部路由到可写的那个来源，一个都没有时明确失败。
   *
   * **本次不实现。** 声明成可选，于是合成实现可以干脆不提供它 —— 必选会逼出一个
   * 只会抛异常的空壳，那既是死代码，也在类型上骗人（签名说它能装，实际调用必炸）。
   * 将来补实现时把 `?` 去掉，所有调用点会当场变红。
   *
   * 缺的是**保活那一半**，不是权限：会话里能用 `ctx.makeSBlob` 往 CAS 写字节，但
   * 只被租户登记表引用的字体 24 小时租约到期后会被 GC 收走（见
   * docs/psd-text-layers.md §5.4「看起来好了一天，然后凭空消失」）。
   */
  install?(entry: FontEntry): Promise<void>;
}

/**
 * 索引缓存的存活时长。
 *
 * `setText` 每调用一次就取一次索引，而索引几乎不变 —— 每次排版前多打一次后端纯属
 * 浪费。反过来，永久缓存会让"新登记一套字体"在所有已经热起来的 operator DO 里都
 * 看不见，直到实例被回收，而 operator DO 是跨请求存活的。一分钟的上限把这个窗口
 * 关掉，代价是每分钟至多多打一次后端。
 */
const INDEX_TTL_MS = 60_000;

export function createFontRegistry(options: {
  readonly providers: readonly FontProvider[];
  readonly now?: () => number;
  /**
   * 某个来源 `list()` 失败时的去处。
   *
   * **配了它就 fail-soft**：那个来源这一轮被跳过，其余来源照常合成 —— 租户的
   * 字体 DO 打不通时，内置那一档仍然可用，`setText` 不整体失效。
   * **没配就 fail-hard**：整个 `index()` 拒绝。默认不降级是刻意的 —— 静默吞掉
   * 一个来源，表现是"租户装的字体凭空消失、字换了个字形"，没有任何信号。
   * 降级必须是调用方明确选的，并且它得说清降级之后往哪儿喊。
   */
  readonly onProviderError?: (providerId: string, error: unknown) => void;
}): FontRegistry {
  const now = options.now ?? (() => Date.now());
  const providerById = new Map(options.providers.map(p => [p.id, p]));
  let cached: { at: number; index: Promise<FontIndex> } | null = null;

  const compose = async (): Promise<FontIndex> => {
    const merged = new Map<string, RegisteredFont>();
    // 顺序即优先级：后面的 provider 按 postScriptName 覆盖前面的。租户装的
    // 同名字体盖掉内置的，这就是"用户主动装 external 字体"的扩展点。
    for (const provider of options.providers) {
      let entries: readonly FontEntry[];
      try {
        entries = await provider.list();
      } catch (error) {
        if (!options.onProviderError) throw error;
        options.onProviderError(provider.id, error);
        continue;
      }
      for (const entry of entries) {
        merged.set(entry.postScriptName, { entry, source: provider.id });
      }
    }
    return merged;
  };

  const providerOf = (font: RegisteredFont): FontProvider => {
    const provider = providerById.get(font.source);
    if (!provider) {
      // 只可能是调用方拿了另一个 registry 实例的索引条目过来。静默返回空字节
      // 会表现成"这套字体解析失败"，查起来毫无线索。
      throw new Error(`Unknown font source ${JSON.stringify(font.source)}`);
    }
    return provider;
  };

  return {
    index: () => {
      if (cached && now() - cached.at < INDEX_TTL_MS) return cached.index;
      // 缓存的是 Promise 而不是结果：一个 operator DO 里并发的两次 setText 只该
      // 打一次后端。失败不留在缓存里 —— 否则一次网络抖动会被整整记住一个 TTL，
      // 期间每次 setText 都拿同一个 rejected promise。
      const index = compose();
      const record = { at: now(), index };
      cached = record;
      index.catch(() => { if (cached === record) cached = null; });
      return index;
    },
    read: (font, io) => providerOf(font).read(font.entry, io),
    blobFor: font => providerOf(font).blobFor(font.entry),
  };
}
