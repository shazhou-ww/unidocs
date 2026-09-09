import { describe, expect, it } from "vitest";
import { parseFontFallbacks } from "../src/text/font-fallbacks.js";

const builtin = ["NotoSans-Regular", "NotoSansSC-Regular"];

describe("parseFontFallbacks", () => {
  it("未设时取内置默认值", () => {
    expect(parseFontFallbacks(undefined, builtin)).toEqual(builtin);
  });

  it("显式空串是空链 —— 逃生口，与'未设'必须可区分", () => {
    expect(parseFontFallbacks("", builtin)).toEqual([]);
  });

  it("逗号分隔、trim、丢空段", () => {
    expect(parseFontFallbacks(" A , ,B ", builtin)).toEqual(["A", "B"]);
  });
});
