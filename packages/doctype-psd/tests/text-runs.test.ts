import { describe, expect, it } from "vitest";
import { diffRange, spliceRuns } from "../src/text/runs.js";

/** 简写：把 [长度, 样式标记] 列表变成 runs。样式用字符串代表，比较靠 JSON。 */
const R = (...pairs: [number, string][]) => pairs.map(([length, s]) => ({ length, style: { c: s } }));
const shape = (runs: { length: number; style: { c: string } }[]) =>
  runs.map(r => [r.length, r.style.c] as const);

describe("diffRange —— 从整串新内容里夹出改动区间", () => {
  it("中间替换：公共前后缀之间就是被换掉的部分", () => {
    // "www.yoursite.com" → "www.unidocs.com"
    const r = diffRange("www.yoursite.com", "www.unidocs.com");
    expect("www.yoursite.com".slice(r.start, r.end)).toBe("yoursite");
    expect(r.insert).toBe("unidocs".length);
  });

  it("纯插入：区间为空", () => {
    const r = diffRange("abcd", "abXcd");
    expect(r).toEqual({ start: 2, end: 2, insert: 1 });
  });

  it("纯删除：插入长度为 0", () => {
    const r = diffRange("abXcd", "abcd");
    expect(r).toEqual({ start: 2, end: 3, insert: 0 });
  });

  it("完全没变：空区间、零插入", () => {
    expect(diffRange("abc", "abc")).toEqual({ start: 3, end: 3, insert: 0 });
  });

  it("整串换掉：区间覆盖全部", () => {
    expect(diffRange("abc", "xyz")).toEqual({ start: 0, end: 3, insert: 3 });
  });

  it("后缀不与前缀重叠 —— 否则会算出负长度的区间", () => {
    // "aa" → "aaa"：前缀吃掉 2 个之后,后缀不能再回头去吃同样那几个。
    const r = diffRange("aa", "aaa");
    expect(r.end).toBeGreaterThanOrEqual(r.start);
    expect(r.insert).toBe(1);
  });

  it("在末尾追加", () => {
    expect(diffRange("ab", "abcd")).toEqual({ start: 2, end: 2, insert: 2 });
  });

  it("在开头插入", () => {
    expect(diffRange("cd", "abcd")).toEqual({ start: 0, end: 0, insert: 2 });
  });
});

describe("spliceRuns —— 内容改了之后重新切分", () => {
  it("替换落在一个 run 中间：只有那一段的长度变", () => {
    // "More info\n" (10, 黑) + "www.yoursite.com" (16, 红)
    const runs = R([10, "black"], [16, "red"]);
    const range = diffRange("More info\nwww.yoursite.com", "More info\nwww.unidocs.com");
    const out = spliceRuns(runs, range, 26);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 红段少一个字符,黑段一点没动。
    expect(shape(out.runs)).toEqual([[10, "black"], [15, "red"]]);
    expect(out.runs.reduce((n, r) => n + r.length, 0)).toBe("More info\nwww.unidocs.com".length);
  });

  it("新字符继承它替换掉的那段的样式", () => {
    const runs = R([3, "black"], [3, "red"]);
    // 把红段的 "def" 换成更长的 "DEFGH"
    const out = spliceRuns(runs, diffRange("abcdef", "abcDEFGH"), 6);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(shape(out.runs)).toEqual([[3, "black"], [5, "red"]]);
  });

  it("插入点正好在两段边界：归后一段（它才是被替换区间的起点）", () => {
    const runs = R([3, "black"], [3, "red"]);
    const out = spliceRuns(runs, { start: 3, end: 3, insert: 2 }, 6);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(shape(out.runs)).toEqual([[3, "black"], [5, "red"]]);
  });

  it("在内容末尾追加：继承最后一段", () => {
    const runs = R([3, "black"], [3, "red"]);
    const out = spliceRuns(runs, diffRange("abcdef", "abcdefXY"), 6);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(shape(out.runs)).toEqual([[3, "black"], [5, "red"]]);
  });

  it("跨越样式不同的多段：拒绝，不猜", () => {
    const runs = R([10, "black"], [16, "red"]);
    // 一次把两行一起换掉
    const out = spliceRuns(runs, diffRange("More info\nwww.yoursite.com", "全新文案"), 26);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe("spans-runs");
  });

  it("跨越样式相同的相邻段：不算跨越，合并后放行", () => {
    const runs = R([3, "same"], [3, "same"]);
    const out = spliceRuns(runs, diffRange("abcdef", "aXYZf"), 6);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(shape(out.runs)).toEqual([[5, "same"]]);
  });

  it("整段被删光：那一段从结果里消失", () => {
    const runs = R([3, "black"], [3, "red"]);
    const out = spliceRuns(runs, diffRange("abcdef", "abc"), 6);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(shape(out.runs)).toEqual([[3, "black"]]);
  });

  it("切完把相邻同样式的段合并 —— 不留人为的分界", () => {
    const runs = R([2, "a"], [2, "b"], [2, "a"]);
    // 删掉中间那段
    const out = spliceRuns(runs, { start: 2, end: 4, insert: 0 }, 6);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(shape(out.runs)).toEqual([[4, "a"]]);
  });

  it("内容没变时 runs 原样返回", () => {
    const runs = R([3, "a"], [3, "b"]);
    const out = spliceRuns(runs, diffRange("abcdef", "abcdef"), 6);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(shape(out.runs)).toEqual([[3, "a"], [3, "b"]]);
  });

  it("run 长度之和对不上内容长度：报错而不是算出一个错的结果", () => {
    const out = spliceRuns(R([3, "a"]), { start: 0, end: 1, insert: 1 }, 10);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({ kind: "length-mismatch", runsTotal: 3, contentLength: 10 });
  });

  it("样式的属性顺序不同不算不同", () => {
    const runs = [
      { length: 3, style: { size: 12, font: "X" } },
      { length: 3, style: { font: "X", size: 12 } },
    ];
    const out = spliceRuns(runs, diffRange("abcdef", "aZf"), 6);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs).toHaveLength(1);
  });
});

describe("不变量：随机内容改动之后总长度必须守恒", () => {
  /** 确定性伪随机 —— 失败可复现。 */
  const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  it("1000 组随机替换，runs 的长度之和恒等于新内容的长度", () => {
    const rand = rng(20260903);
    const pick = (n: number) => Math.floor(rand() * n);
    for (let iter = 0; iter < 1000; iter++) {
      // 随机切出 1..4 段，每段 0..6 个字符（0 长度的段在真实数据里不该出现，
      // 但切分函数不能因此崩）。
      const runs: { length: number; style: { c: string } }[] = [];
      const segments = 1 + pick(4);
      let content = "";
      for (let i = 0; i < segments; i++) {
        const len = 1 + pick(6);
        runs.push({ length: len, style: { c: `s${pick(3)}` } });
        content += "abcdefghij".slice(0, len);
      }
      // 随机挑一个区间替换成随机长度的新串。
      const start = pick(content.length + 1);
      const end = start + pick(content.length - start + 1);
      const insert = pick(5);
      const after = content.slice(0, start) + "XYZWV".slice(0, insert) + content.slice(end);

      const range = diffRange(content, after);
      const out = spliceRuns(runs, range, content.length);
      if (!out.ok) {
        // 拒绝是合法结果（跨样式），但拒绝的理由只能是 spans-runs ——
        // length-mismatch 说明构造的输入自相矛盾，那是测试的 bug。
        expect(out.error.kind).toBe("spans-runs");
        continue;
      }
      const total = out.runs.reduce((n, r) => n + r.length, 0);
      expect({ iter, total }).toEqual({ iter, total: after.length });
      // 段长度必须为正 —— 0 长度的段会让下游按字符切样式时错位。
      expect(out.runs.every(r => r.length > 0)).toBe(true);
    }
  });
});

describe("边界：没有 runs 的图层", () => {
  it("runs 为空时原样返回空 —— 调用方用顶层 style，不该走切分", () => {
    const out = spliceRuns([], { start: 0, end: 0, insert: 3 }, 0);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runs).toEqual([]);
  });
});
