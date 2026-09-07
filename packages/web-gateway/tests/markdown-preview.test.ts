import { describe, expect, it } from "vitest";
import { markdownPreviewHtml } from "../src/ui/views/markdown-preview.js";

describe("Markdown cloud preview", () => {
  it("renders headings, lists and safe external links", () => {
    const result = markdownPreviewHtml("# 文档\n\n- 内容\n\n[Reference](https://example.test)");
    expect(result).toContain("<h1>文档</h1>"); expect(result).toContain("<li>内容</li>");
    expect(result).toContain('rel="noopener noreferrer"');
  });
  it("removes scripts, event handlers and external image loads", () => {
    const result = markdownPreviewHtml('<script>alert(1)</script><img src="https://tracking.test/pixel" onerror="alert(1)" alt="diagram"><iframe src="https://tracking.test"></iframe><a href="javascript:alert(1)">bad</a><p style="background:url(https://tracking.test)">text</p>');
    expect(result).not.toMatch(/<script|onerror|<iframe|javascript:|<img|src=|style=/i);
    expect(result).toContain("外链图片未加载");
  });
});