/**
 * 样本数据。六处讨论对应 spec §4.2 的右栏四种渲染，外加纯 reply 与基于 current 两种。
 * 偏移一律由 rangeOf 按原文查出，不写死数字——写死会在内容改动后静默错位。
 */
import { createMarkdownTextRange } from "../doctypes/markdown.js";
import type { MemorySeed, SeedThread } from "./store.js";

export function rangeOf(content: string, quote: string): { start: number; end: number } {
  const start = content.indexOf(quote);
  if (start === -1) throw new Error(`seed quote not found in content: ${quote}`);
  return { start, end: start + quote.length };
}

const V0 = [
  "# UniDocs 产品构想",
  "",
  "平台让人和外部 Agent 共同创作数字作品。",
  "",
  "## 版本引用约定",
  "",
  "引用固定到明确版本，源作品更新时提示。",
  "",
  "## 早期措辞",
  "",
  "这一段写得很绕，回头要换掉。",
  "",
].join("\n");

const V1 = V0.replace(
  "引用固定到明确版本，源作品更新时提示。",
  "引用固定到明确版本；源作品更新时提示，由人主动切换。",
);

// 第三处的锚点原文在这一版被 Agent 顺带改写掉了。
const V2 = V1.replace("这一段写得很绕，回头要换掉。", "这一节已重写为简明表述。");

function location(content: string, quote: string) {
  const { start, end } = rangeOf(content, quote);
  return createMarkdownTextRange({ documentContractIdx: 0, content, start, end });
}

function threads(): SeedThread[] {
  return [
    // 1. 待回复：有 comment 没 reply。
    {
      threadId: "th-open",
      comments: [{ baseVersionIdx: 2, text: "这一句还能再收紧吗？", location: location(V2, "平台让人和外部 Agent 共同创作数字作品。") }],
      replies: [],
    },
    // 2. 已回复且 reply 产生新版本：右栏金色高亮。
    {
      threadId: "th-answered",
      comments: [{ baseVersionIdx: 0, text: "这里要说清楚谁来切换", location: location(V0, "引用固定到明确版本，源作品更新时提示。") }],
      replies: [{
        respondThroughCommentIdx: 0,
        text: "已补上「由人主动切换」。",
        producesContent: V1,
        resultLocations: [location(V1, "引用固定到明确版本；源作品更新时提示，由人主动切换。")],
      }],
    },
    // 3. 基于旧版本、内容仍在：右栏灰底虚线。
    {
      threadId: "th-stale-present",
      comments: [{ baseVersionIdx: 0, text: "标题层级是不是深了一层", location: location(V0, "版本引用约定") }],
      replies: [],
    },
    // 4. 基于旧版本、原文已被改写：右栏不高亮，只给说明。
    {
      threadId: "th-stale-rewritten",
      comments: [{ baseVersionIdx: 0, text: "这段确实绕，建议拆成两句", location: location(V0, "这一段写得很绕，回头要换掉。") }],
      replies: [],
    },
    // 5. 纯 reply：只回复，没产生新版本，不能显示版本号。
    {
      threadId: "th-plain-reply",
      comments: [{ baseVersionIdx: 2, text: "「数字作品」在这里指什么？", location: location(V2, "数字作品") }],
      replies: [{ respondThroughCommentIdx: 0, text: "指平台上一切有版本身份的创作产物，这里不改正文。" }],
    },
    // 6. comment 就写在 current 上：左右同版，右栏标「暂无改动」。
    {
      threadId: "th-on-current",
      comments: [{ baseVersionIdx: 2, text: "这节改得不错", location: location(V2, "这一节已重写为简明表述。") }],
      replies: [],
    },
  ];
}

export function sampleSeed(): MemorySeed {
  return {
    documents: [
      { documentId: "doc-sample", name: "UniDocs · 产品构想", versions: [{ content: V0 }, { content: V1 }, { content: V2 }], threads: threads() },
      { documentId: "doc-empty", name: "共创空间 · 发布手记", versions: [{ content: "# 发布手记\n\n还没开始写。\n" }], threads: [] },
    ],
  };
}
