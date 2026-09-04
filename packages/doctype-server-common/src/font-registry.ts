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

/** 覆盖的码位区间,合并后按起点升序排列,区间之间不重叠也不相邻。 */
export type FontCoverage = readonly (readonly [number, number])[];

export interface FontEntry {
  readonly postScriptName: string;
  readonly family: string;
  /** CAS 里字体文件的内容哈希。 */
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

/**
 * 作用域是 (stackId, tenantId),跨会话存活。适配器构造时绑定这两段身份,
 * 所以方法签名里没有它们。
 */
export interface FontRegistry {
  list(): Promise<readonly FontEntry[]>;
  /** 幂等:同一个 postScriptName 重登记覆盖旧的一条,不是报冲突 ——
   *  预置脚本每次跑都会把配置里的全套字体登记一遍。 */
  put(entry: FontEntry): Promise<void>;
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
