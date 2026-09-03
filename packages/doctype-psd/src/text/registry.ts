/**
 * 选字体的纯逻辑：一个 PSD 图层的文字可能中英混排，一套字体未必两种都
 * 覆盖，所以选字体是**逐码位**的，不是逐图层的（见 `font.ts` 里
 * `FaceResolver` 的注释）。
 *
 * 同一套"按候选顺序挑第一个认识这个码位的候选"要在两个不同时刻各跑一次
 * （协调者裁定 R17）：
 *   - 装载前（异步 effect 里，只有 `FontIndex`，还没读字节）：靠 `coverage`
 *     区间判断，不用真的取字体字节。
 *   - 排版时（同步，`layoutText` 内部）：靠已装载 `FontFace` 的 `has()`。
 * 两处判据不同，但"挑第一个认识的候选"这段逻辑相同，所以抽成共享的 `pick`，
 * 两个导出函数只是各自喂不同的 `knows` 判据。
 */
import type { FaceResolver, FontFace } from "./font.js";
import type { FontCoverage } from "./opentype-face.js";

export interface FontEntry {
  readonly postScriptName: string;
  readonly family: string;
  /** CAS 里字体文件的内容哈希。 */
  readonly hash: string;
  /** 从字体文件**解析**出来的，不是登记时人工填的 —— 填错了字还是那些字，位置全错。 */
  readonly unitsPerEm: number;
  /** 覆盖的码位区间，合并后按起点升序排列，区间之间不重叠也不相邻。 */
  readonly coverage: FontCoverage;
}

/** 按 postScriptName 索引。 */
export type FontIndex = ReadonlyMap<string, FontEntry>;

/** 按候选顺序挑第一个"认识"这个码位的候选；都不认识返回 null。
 *  `knows` 是判据，两个调用方各喂各的。 */
function pick<T>(
  candidates: readonly T[],
  codePoint: number,
  knows: (candidate: T, codePoint: number) => boolean,
): T | null {
  for (const candidate of candidates) {
    if (knows(candidate, codePoint)) return candidate;
  }
  return null;
}

/** 在合并后的（升序、不重叠）覆盖区间里二分查 codePoint 是否落在某个区间内。 */
function coversCodePoint(coverage: FontCoverage, codePoint: number): boolean {
  let lo = 0;
  let hi = coverage.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = coverage[mid];
    if (codePoint < start) {
      hi = mid - 1;
    } else if (codePoint > end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/** 排版侧：同步逐码位选字体。`loaded` 按 postScriptName 索引已装载的字体。
 *
 * 候选顺序：请求的字体（`FaceResolver` 每次调用时传入的
 * `requestedFont`）→ `fallbacks` 按给定顺序 → null。请求的字体如果不在
 * `loaded` 里（索引里有但没装载，或者压根没有这套字体），直接跳过继续走
 * fallbacks，不是提前返回 null —— 一个 run 缺一套字体不该让整条回退链
 * 报废。 */
export function resolveFaceChain(
  loaded: ReadonlyMap<string, FontFace>,
  fallbacks: readonly string[],
): FaceResolver {
  return (codePoint, requestedFont) => {
    const candidates = requestedFont !== undefined ? [requestedFont, ...fallbacks] : fallbacks;
    const name = pick(candidates, codePoint, (postScriptName, cp) => {
      const face = loaded.get(postScriptName);
      return face !== undefined && face.has(cp);
    });
    return name === null ? null : loaded.get(name)!;
  };
}

/** 装载侧：给定要排的文字，算出需要从 CAS 取哪几套字体（按 postScriptName，
 *  保持候选顺序，去重）。不读任何字节 —— `coverage` 存进索引就是为了让这
 *  一步不必先取字体文件。
 *
 *  遍历 `content` 用码位（`for...of`），不是 UTF-16 码元 —— 表情和生僻字
 *  会被拆成两个代理项，按码元查覆盖范围会两个都查不到。 */
export function selectFonts(
  index: FontIndex,
  requested: string | undefined,
  fallbacks: readonly string[],
  content: string,
): string[] {
  const candidates = requested !== undefined ? [requested, ...fallbacks] : fallbacks;
  const needed = new Set<string>();
  for (const ch of content) {
    const codePoint = ch.codePointAt(0)!;
    const name = pick(candidates, codePoint, (postScriptName, cp) => {
      const entry = index.get(postScriptName);
      return entry !== undefined && coversCodePoint(entry.coverage, cp);
    });
    if (name !== null) needed.add(name);
  }
  // Set 按插入顺序遍历，但插入顺序未必是候选顺序（后出现的字符可能先命中
  // 排在后面的候选）；按 candidates 本身的顺序过滤一遍，既还原顺序又去重
  // （`emitted` 防的是 candidates 里本身出现重复名字的边角情况）。
  const emitted = new Set<string>();
  const result: string[] = [];
  for (const name of candidates) {
    if (needed.has(name) && !emitted.has(name)) {
      emitted.add(name);
      result.push(name);
    }
  }
  return result;
}
