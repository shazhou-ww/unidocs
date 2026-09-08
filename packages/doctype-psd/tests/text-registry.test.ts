import { describe, it, expect } from "vitest";
import type { FontFace } from "../src/text/font.js";
import type { FontCoverage } from "../src/text/opentype-face.js";
import type { RegisteredFont } from "@unidocs/doctype-server-common";
import type { FontIndex } from "../src/text/registry.js";
import { resolveFaceChain, selectFonts } from "../src/text/registry.js";
import { fakeFace } from "./text-fake-face.js";

/** 索引里装的是 RegisteredFont（`{ entry, source }`）。`source` 对 selectFonts
 *  没有影响 —— 它只看 coverage —— 所以这里一律填同一个值。 */
function entry(postScriptName: string, coverage: FontCoverage): RegisteredFont {
  return {
    entry: { postScriptName, family: postScriptName, hash: `hash-${postScriptName}`, unitsPerEm: 1000, coverage },
    source: "test",
  };
}

describe("resolveFaceChain", () => {
  it("逐字符回退：英文用请求的字体，中文掉到中文兜底", () => {
    const loaded = new Map<string, FontFace>([
      ["JosefinSans-Bold", fakeFace({ postScriptName: "JosefinSans-Bold", missing: "中" })],
      ["NotoSans", fakeFace({ postScriptName: "NotoSans", missing: "中" })],
      ["NotoSansSC", fakeFace({ postScriptName: "NotoSansSC" })],
    ]);
    const resolve = resolveFaceChain(loaded, ["NotoSans", "NotoSansSC"]);
    expect(resolve(0x41, "JosefinSans-Bold")?.postScriptName).toBe("JosefinSans-Bold");
    expect(resolve(0x4e2d, "JosefinSans-Bold")?.postScriptName).toBe("NotoSansSC");
  });

  it("请求的字体不在 loaded 里时跳过它，继续走 fallbacks（不是返回 null）", () => {
    const loaded = new Map<string, FontFace>([["NotoSans", fakeFace({ postScriptName: "NotoSans" })]]);
    const resolve = resolveFaceChain(loaded, ["NotoSans"]);
    // "Ghost" 压根没在 loaded 里登记
    expect(resolve(0x41, "Ghost")?.postScriptName).toBe("NotoSans");
  });

  it("requestedFont 为 undefined 时直接从 fallbacks 开始", () => {
    const loaded = new Map<string, FontFace>([["NotoSans", fakeFace({ postScriptName: "NotoSans" })]]);
    const resolve = resolveFaceChain(loaded, ["NotoSans"]);
    expect(resolve(0x41, undefined)?.postScriptName).toBe("NotoSans");
  });

  it("整条链都不认识这个码位时返回 null", () => {
    const loaded = new Map<string, FontFace>([
      ["A", fakeFace({ postScriptName: "A", missing: "中" })],
      ["B", fakeFace({ postScriptName: "B", missing: "中" })],
    ]);
    const resolve = resolveFaceChain(loaded, ["B"]);
    expect(resolve(0x4e2d, "A")).toBeNull();
  });

  it("两个候选都认识同一个码位时，命中排在前面的那个——顺序不能被打乱", () => {
    // A、B 都不带 missing，默认什么都认识；如果候选数组被 reverse 了，
    // 命中的会变成 B，这条用例才拦得住。
    const loaded = new Map<string, FontFace>([
      ["A", fakeFace({ postScriptName: "A" })],
      ["B", fakeFace({ postScriptName: "B" })],
    ]);
    const resolve = resolveFaceChain(loaded, ["A", "B"]);
    expect(resolve(0x41, undefined)?.postScriptName).toBe("A");
  });
});

describe("selectFonts", () => {
  it("只返回真正用得上的字体：纯英文内容不该拉进中文兜底", () => {
    const index: FontIndex = new Map([
      ["NotoSans", entry("NotoSans", [[0x20, 0x7e]])],
      ["NotoSansSC", entry("NotoSansSC", [[0x4e00, 0x9fff]])],
    ]);
    const result = selectFonts(index, undefined, ["NotoSans", "NotoSansSC"], "Hello");
    expect(result).toEqual(["NotoSans"]);
  });

  it("去重且保持候选顺序", () => {
    const index: FontIndex = new Map([
      ["NotoSans", entry("NotoSans", [[0x20, 0x7e]])],
      ["NotoSansSC", entry("NotoSansSC", [[0x4e00, 0x9fff]])],
    ]);
    // 内容里中英字符交替出现多次，selectFonts 不该重复列出同一套字体，
    // 且顺序要跟着 fallbacks 给定的顺序，不是内容里出现的顺序。
    const result = selectFonts(index, undefined, ["NotoSans", "NotoSansSC"], "中Aa中Bb中");
    expect(result).toEqual(["NotoSans", "NotoSansSC"]);
  });

  it("请求的字体排在候选顺序最前面", () => {
    const index: FontIndex = new Map([
      ["Josefin", entry("Josefin", [[0x20, 0x7e]])],
      ["NotoSans", entry("NotoSans", [[0x20, 0x7e]])],
    ]);
    const result = selectFonts(index, "Josefin", ["NotoSans"], "Hello");
    expect(result).toEqual(["Josefin"]);
  });

  it("二分查找边界：区间起点、终点、区间之间的空隙、第一个区间之前、最后一个区间之后", () => {
    // 两个区间：[0x41,0x45]（A-E）和 [0x61,0x65]（a-e），中间 0x46-0x60 是空隙。
    const index: FontIndex = new Map([["F", entry("F", [[0x41, 0x45], [0x61, 0x65]])]]);
    const covered = (cp: number) => selectFonts(index, undefined, ["F"], String.fromCodePoint(cp));

    expect(covered(0x41)).toEqual(["F"]); // 第一个区间起点
    expect(covered(0x45)).toEqual(["F"]); // 第一个区间终点
    expect(covered(0x61)).toEqual(["F"]); // 第二个区间起点
    expect(covered(0x65)).toEqual(["F"]); // 第二个区间终点
    expect(covered(0x50)).toEqual([]); // 区间之间的空隙
    expect(covered(0x40)).toEqual([]); // 第一个区间之前
    expect(covered(0x66)).toEqual([]); // 最后一个区间之后
  });

  it("单点区间能被查到", () => {
    const index: FontIndex = new Map([["F", entry("F", [[0x41, 0x41]])]]);
    const result = selectFonts(index, undefined, ["F"], "A");
    expect(result).toEqual(["F"]);
  });

  it("代理项对（补充平面字符）按码位查覆盖，不是按 UTF-16 码元——𠮷 是 U+20BB7", () => {
    // 用 charCodeAt 逐码元遍历会把 𠮷 拆成两个孤立代理项，两个都查不到这个
    // 区间；必须用 codePointAt（for...of 遍历字符串就是这么做的）才查得到。
    const index: FontIndex = new Map([["ExtB", entry("ExtB", [[0x20bb7, 0x20bb7]])]]);
    const result = selectFonts(index, undefined, ["ExtB"], "𠮷");
    expect(result).toEqual(["ExtB"]);
  });

  it("emitted 去重防的是 fallbacks 内部本身重名的边角情况", () => {
    const index: FontIndex = new Map([["A", entry("A", [[0x41, 0x41]])]]);
    const result = selectFonts(index, undefined, ["A", "A"], "A");
    expect(result).toEqual(["A"]);
  });
});
