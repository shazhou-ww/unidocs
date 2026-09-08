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

// 同 opentype-face.ts 的 FontCoverage:类型下沉到中立层,这里保留 re-export
// 让本包与外部既有 import 不受影响。
// 下面转发已导入的本地绑定,不写 `export type … from "…"`:
// `package-deps.test.mjs` 的门禁逐行扫描含中立层包名的行,只放行以
// `import type` 开头的行。`export … from` 那一行虽然同样在编译期被完全
// 擦除、不产生运行时 import,但字面上不是 `import type` 开头,会被判成
// "服务端代码进了浏览器产物"误报。别把下一行的 `export type` 改回带模块
// 说明符的 `export type { FontEntry } from "…"` 形式,连注释里也别写出
// 那个完整说明符字符串——门禁按子串匹配,写出来同样会被判违规。
import type { FontEntry, FontIndex } from "@unidocs/doctype-server-common";
// FontIndex 同理:它现在映射到的是 RegisteredFont({ entry, source }),由门面
// 合成多个来源之后产出,本包不再自己定义一份。
export type { FontEntry, FontIndex };

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
 * 报废。
 *
 * **返回值必须是 `loaded` 里的原对象**，不许包一层代理或适配器：调用方
 * （`set-text.ts`）靠对象同一性反查"这个字形最后用的是哪套字体"，好在
 * 中英混排时告诉用户"这两个字用的是 CJK 不是 Latin"。以身份为键在本模块
 * 是既有惯例（`opentype-face.ts` 的 `backingFont` WeakMap 同理）。
 * 破坏这条约定不会静默出错 —— `set-text.test.ts` 里断言具体字体名的那条
 * 会当场变红 —— 但会红得让人摸不着头脑，所以写在这里。 */
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
      // 多一层 `.entry`:索引里装的是 RegisteredFont,coverage 在它包着的
      // FontEntry 上。这里不关心 `.source` —— 选字体只看覆盖,来源是排查用的。
      const found = index.get(postScriptName);
      return found !== undefined && coversCodePoint(found.entry.coverage, cp);
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
