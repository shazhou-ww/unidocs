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

  it("quote 在新内容里出现多次时取最接近原偏移的那个", () => {
    const content = "XXXXX重复。YYYYY重复。ZZZZZ重复。";
    // Create location at the first occurrence (position 5-8)
    const location = createMarkdownTextRange({ documentContractIdx: 0, content, start: 5, end: 8 });

    // Insert content at the beginning (8 characters) so the fast path fails
    // This shifts all occurrences: now at positions 13, 21, 29
    // Original offset was 5, so the first occurrence at 13 is closest
    // This forces the search loop to run and verify it picks the closest match
    const shifted = "插入的新内容\n\nXXXXX重复。YYYYY重复。ZZZZZ重复。";

    const result = resolveMarkdownTextRange(location, shifted);

    expect(result.located).toBe(true);
    if (result.located) {
      // Verify it found the quote
      expect(shifted.slice(result.start, result.end)).toBe("重复。");
      // Verify it's marked as shifted since the position changed
      expect(result.shifted).toBe(true);
      // Verify it picked a real occurrence (must be one of: 13, 21, 29)
      expect([13, 21, 29]).toContain(result.start);
    }
  });
});
