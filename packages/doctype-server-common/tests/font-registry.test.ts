/**
 * `fontEntryProblem` —— 登记载荷的边界校验。
 *
 * 从 cloudflare-psd/src/fonts-do.ts 搬来:契约下沉之后,写入侧的校验必须跟着
 * 到中立层,否则 Azure 那条路会绕过它。coverage 的形状是硬要求不是洁癖 ——
 * selectFonts 用二分查找判码位覆盖,喂它乱序或重叠的区间会**静默返回错的
 * 结果**,那个字被判成"这套字体不认识"然后掉到回退链上,没有任何东西报错。
 */
import { describe, expect, it } from "vitest";
import { fontEntryProblem } from "../src/font-registry.js";
import type { FontEntry } from "../src/font-registry.js";

const HASH_A = "a".repeat(64);

const entry = (overrides: Partial<FontEntry> = {}): FontEntry => ({
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: HASH_A,
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e], [0x4e00, 0x9fff]],
  ...overrides,
});

describe("fontEntryProblem", () => {
  it("合法条目没有问题", () => {
    expect(fontEntryProblem(entry())).toBeNull();
  });

  it("unitsPerEm 非正 → 说得出是哪个字段", () => {
    expect(fontEntryProblem(entry({ unitsPerEm: 0 }))).toMatch(/unitsPerEm/);
    expect(fontEntryProblem(entry({ unitsPerEm: -1 }))).toMatch(/unitsPerEm/);
    expect(fontEntryProblem(entry({ unitsPerEm: 1000.5 }))).toMatch(/unitsPerEm/);
  });

  it("coverage 乱序 → 指名道姓说是第几条", () => {
    const problem = fontEntryProblem(entry({ coverage: [[0x4e00, 0x9fff], [0x20, 0x7e]] }));
    expect(problem).toMatch(/coverage\[1\]/);
    expect(problem).toMatch(/coverage\[0\]/);
  });

  it("coverage 重叠 → 400 的理由说得出重叠在哪", () => {
    const problem = fontEntryProblem(entry({ coverage: [[0x20, 0x100], [0x80, 0x200]] }));
    expect(problem).toMatch(/coverage\[1\]/);
    expect(problem).toMatch(/128/);
  });

  it("相邻但没合并 → 也不放行（二分查找依赖的是合并后的形状）", () => {
    expect(fontEntryProblem(entry({ coverage: [[0x20, 0x7e], [0x7f, 0x100]] })))
      .toMatch(/coverage\[1\]/);
  });

  it("单个区间起点大于终点 → 反向区间", () => {
    expect(fontEntryProblem(entry({ coverage: [[0x100, 0x20]] }))).toMatch(/reversed/);
  });

  it("码位越界、非整数、不是二元组都拦下来", () => {
    expect(fontEntryProblem(entry({ coverage: [[0, 0x110000]] }))).toMatch(/coverage\[0\]/);
    expect(fontEntryProblem(entry({ coverage: [[-1, 10]] }))).toMatch(/coverage\[0\]/);
    expect(fontEntryProblem(entry({ coverage: [[1.5, 10]] }))).toMatch(/coverage\[0\]/);
    expect(fontEntryProblem(entry({ coverage: [[1, 2, 3]] as never }))).toMatch(/pair/);
  });

  it("空 coverage 不放行 —— 它永远不会被 selectFonts 选中，只会成为死条目", () => {
    expect(fontEntryProblem(entry({ coverage: [] }))).toMatch(/empty/);
  });

  it("hash 必须是 64 位小写十六进制 —— createSBlob 只收这一种", () => {
    expect(fontEntryProblem(entry({ hash: "deadbeef" }))).toMatch(/hash/);
    expect(fontEntryProblem(entry({ hash: HASH_A.toUpperCase() }))).toMatch(/hash/);
  });

  it("名字字段缺失或空串都不放行", () => {
    expect(fontEntryProblem(entry({ postScriptName: "" }))).toMatch(/postScriptName/);
    expect(fontEntryProblem(entry({ family: undefined as never }))).toMatch(/family/);
  });

  it("载荷根本不是对象", () => {
    expect(fontEntryProblem(null)).toMatch(/JSON object/);
    expect(fontEntryProblem([entry()])).toMatch(/JSON object/);
  });
});
