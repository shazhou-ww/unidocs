/**
 * 文字内容替换时的分段（run）重切分。
 *
 * `LayerText.runs[]` 的 `length` 是**字符数**，顺次覆盖 `content`。内容一改，
 * 每段覆盖的范围就得重算 —— 不重算的话样式和字符就错位了，第二行的红色会跑
 * 到第一行去。
 *
 * 这里是纯函数：`setText` 那个 effect 要做 IO（取字体），但切分不需要，
 * 所以拆出来单独测（设计文档 §5）。
 */
import type { LayerParagraphRun, LayerTextRun, LayerTextStyle } from "../model/types.js";

/** 被替换掉的区间 `[start, end)`，以及替换进去的字符数。 */
export interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly insert: number;
}

/**
 * 用最长公共前缀 + 最长公共后缀把两个字符串的差异夹出来。
 *
 * 调用方给的是**整串新内容**（让 LLM 算字符偏移量太容易错位），差异区间由
 * 这里推导。
 *
 * "aa" → "aaa" 这类情况区间本身是有歧义的（插入的字符可以算在任何位置），
 * 但**只要歧义范围落在同一个 run 里，选哪个都等价** —— 样式是一样的。跨 run
 * 的情况由 {@link spliceRuns} 拒绝，所以这里的歧义不会造成错误的样式。
 *
 * 按 UTF-16 码元计算，与 `String.length` 和 `runs[].length` 同一口径。
 */
export function diffRange(before: string, after: string): Replacement {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  // 后缀不能与前缀重叠，否则会得到负长度的区间。
  let suffix = 0;
  while (
    suffix < max - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;
  return { start: prefix, end: before.length - suffix, insert: after.length - prefix - suffix };
}

/** 两个样式是否等价。字段少且都是标量/浅对象，JSON 序列化比较足够。 */
function sameStyle(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/** 键排序后的 JSON —— 属性顺序不同不该被当成样式不同。 */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableJson(val)}`).join(",")}}`;
}

/** 一段：只关心长度和样式，字符样式和段落样式共用这个形状。 */
interface Run<S> { length: number; style: S }

/**
 * 切分失败的原因。**拒绝而不是猜** —— 猜错了用户会看到样式莫名其妙地跑掉，
 * 而那种错很难归因。
 */
export type SpliceError =
  /** 替换区间跨越了样式不同的多个 run。 */
  | { readonly kind: "spans-runs"; readonly styles: number }
  /** run 的长度之和与内容长度对不上,说明上游数据本身就是坏的。 */
  | { readonly kind: "length-mismatch"; readonly runsTotal: number; readonly contentLength: number };

export type SpliceResult<S> = { ok: true; runs: Run<S>[] } | { ok: false; error: SpliceError };

/**
 * 按替换区间重切分 runs。
 *
 * 规则（设计文档 §5.3）：
 * - 完全在 `start` 之前 / `end` 之后的 run：长度不变
 * - 与 `[start, end)` 相交的 run：按相交长度缩短
 * - 新插入的字符：**继承 `start` 落在的那个 run 的样式** —— "新文字用它替换掉
 *   的那段文字的样式"，和文本编辑器里替换选区的行为一致
 *
 * 跨越样式不同的多个 run 时**拒绝**（§5.4）：塌成一段必然丢样式。样式相同的
 * 相邻 run 不算跨越 —— 它们本来就该是一段。
 *
 * `contentLength` 是替换**之前**的内容长度，用来校验 runs 的完整性。
 */
export function spliceRuns<S>(
  runs: readonly Run<S>[],
  range: Replacement,
  contentLength: number,
): SpliceResult<S> {
  const total = runs.reduce((n, r) => n + r.length, 0);
  if (total !== contentLength) {
    return { ok: false, error: { kind: "length-mismatch", runsTotal: total, contentLength } };
  }

  // 先看区间碰到了哪些 run。空区间（纯插入）碰到的是"包含 start 的那一个"。
  const touched: number[] = [];
  let at = 0;
  for (let i = 0; i < runs.length; i++) {
    const from = at, to = at + runs[i].length;
    // 半开区间相交；纯插入（start === end）时落在 [from, to) 里就算碰到。
    const intersects = range.start === range.end
      ? range.start >= from && range.start < to
      : range.start < to && range.end > from;
    if (intersects) touched.push(i);
    at = to;
  }

  // 区间落在内容末尾（追加）时上面一个都碰不到,继承最后一段。
  if (touched.length === 0 && runs.length > 0) touched.push(runs.length - 1);

  const distinct = new Set(touched.map(i => stableJson(runs[i].style)));
  if (distinct.size > 1) {
    return { ok: false, error: { kind: "spans-runs", styles: distinct.size } };
  }

  // 新字符加在第一个被碰到的 run 上。被碰到的那些 run 样式已经过上面的同一性
  // 校验，所以加在哪一个上都等价。
  const insertAt = touched[0];
  const out: Run<S>[] = [];
  at = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const from = at, to = at + r.length;
    at = to;
    // 这一段里活下来的字符：区间之外的部分。
    const keptBefore = Math.max(0, Math.min(r.length, range.start - from));
    const keptAfter = Math.max(0, to - Math.max(range.end, from));
    const length = keptBefore + keptAfter + (i === insertAt ? range.insert : 0);
    if (length > 0) out.push({ length, style: r.style });
  }
  return { ok: true, runs: mergeAdjacent(out) };
}

/** 相邻且样式相同的段合并 —— 切完可能留下人为的分界。 */
function mergeAdjacent<S>(runs: Run<S>[]): Run<S>[] {
  const out: Run<S>[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, r.style)) last.length += r.length;
    else out.push({ length: r.length, style: r.style });
  }
  return out;
}

/** `LayerTextRun[]` 的具名包装 —— 调用方不必自己带类型参数。 */
export const spliceTextRuns = (
  runs: readonly LayerTextRun[],
  range: Replacement,
  contentLength: number,
): SpliceResult<LayerTextStyle> => spliceRuns(runs, range, contentLength);

/** `LayerParagraphRun[]` 的具名包装。段落样式走同一套规则。 */
export const spliceParagraphRuns = (
  runs: readonly LayerParagraphRun[],
  range: Replacement,
  contentLength: number,
): SpliceResult<LayerParagraphRun["style"]> => spliceRuns(runs, range, contentLength);
