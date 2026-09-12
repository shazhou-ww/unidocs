import { describe, expect, it } from "vitest";
import {
  createMarkdownTextRange,
  readMarkdownTextRange,
  resolveMarkdownTextRange,
} from "../src/doctypes/markdown.js";

const content = "# 标题\n\n这是第一段。\n\n这是第二段。\n";

describe("createMarkdownTextRange", () => {
  it("按偏移量截出 quote 并带上 documentContractIdx", () => {
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: 6, end: 12 });

    expect(location.locationType).toBe("unidocs.markdown.text-range/v1");
    expect(location.documentContractIdx).toBe(0);
    expect(readMarkdownTextRange(location)).toEqual({ start: 6, end: 12, quote: "这是第一段。" });
  });

  it("start 大于 end 时抛错", () => {
    expect(() => createMarkdownTextRange({ documentContractIdx: 0, content, start: 5, end: 2 }))
      .toThrow(/invalid range/);
  });
});

describe("readMarkdownTextRange", () => {
  it("locationType 不匹配时返回 null", () => {
    const location = { documentContractIdx: 0, locationType: "unidocs.psd.layer-region/v2", payload: {} };
    expect(readMarkdownTextRange(location)).toBeNull();
  });

  it("payload 形状不对时返回 null，不抛错", () => {
    const location = {
      documentContractIdx: 0,
      locationType: "unidocs.markdown.text-range/v1",
      payload: { start: "8", end: 14, quote: "x" },
    };
    expect(readMarkdownTextRange(location)).toBeNull();
  });
});

describe("resolveMarkdownTextRange", () => {
  it("同一份内容上原位命中", () => {
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: 6, end: 12 });
    expect(resolveMarkdownTextRange(location, content)).toEqual({ located: true, start: 6, end: 12, shifted: false });
  });

  it("内容前面被插入时按 quote 重新定位，并标记 shifted", () => {
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: 6, end: 12 });
    const moved = "# 标题\n\n新插入的一段。\n\n这是第一段。\n\n这是第二段。\n";

    const result = resolveMarkdownTextRange(location, moved);

    expect(result.located).toBe(true);
    if (result.located) {
      expect(moved.slice(result.start, result.end)).toBe("这是第一段。");
      expect(result.shifted).toBe(true);
    }
  });

  it("quote 已被改写掉时定位失败", () => {
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: 6, end: 12 });
    const rewritten = "# 标题\n\n完全换过的内容。\n\n这是第二段。\n";

    expect(resolveMarkdownTextRange(location, rewritten)).toEqual({ located: false, reason: "unresolvable" });
  });

  it("locationType 不认识时报 unsupported_type", () => {
    const location = { documentContractIdx: 0, locationType: "unidocs.psd.layer-region/v2", payload: {} };
    expect(resolveMarkdownTextRange(location, content)).toEqual({ located: false, reason: "unsupported_type" });
  });

  it("空 quote 时定位失败", () => {
    // Empty quote cannot be reliably resolved since it matches everywhere
    const location = { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 6, end: 6, quote: "" } };
    expect(resolveMarkdownTextRange(location, content)).toEqual({ located: false, reason: "unresolvable" });
  });

  it("quote 在新内容里出现多次时取最接近原偏移的那个，而不是第一个", () => {
    const repeated = "重复。\n\n重复。\n\n重复。\n"; // 三处出现在 0 / 5 / 10
    const location = createMarkdownTextRange({
      documentContractIdx: 0,
      content: repeated,
      start: 10,
      end: 13,
    });

    // 前面插入三个字符，三处变成 3 / 8 / 13。原偏移 10 到它们的距离分别是 7 / 2 / 3，
    // 所以最近的一处是 8，而第一处是 3。取第一处的实现会返回 3，这条断言就会失败。
    const shifted = "开头。" + repeated;

    const result = resolveMarkdownTextRange(location, shifted);

    expect(result).toEqual({ located: true, start: 8, end: 11, shifted: true });
  });
});
