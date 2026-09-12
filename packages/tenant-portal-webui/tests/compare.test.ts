import { describe, expect, it } from "vitest";
import { createMarkdownTextRange } from "@unidocs/tenant-portal-client";
import { decideRightPane } from "../src/model/compare.js";

const content = "# 标题\n\n保留的一段。\n\n另一段。\n";
const at = (quote: string) =>
  createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf(quote), end: content.indexOf(quote) + quote.length });

const comment = (baseVersionIdx: number, quote: string) => ({
  commentIdx: 0, baseVersionIdx, location: at(quote),
  content: { text: "c", richContent: null, attachments: [] }, authorId: "u", createdAt: "x",
});

describe("decideRightPane", () => {
  it("有覆盖该评论的回复时金色高亮结果位置", () => {
    const decision = decideRightPane({
      comment: comment(0, "保留的一段。"),
      replies: [{ replyIdx: 0, respondThroughCommentIdx: 0, resultLocations: [at("另一段。")], content: { text: "改好了", richContent: null, attachments: [] }, authorAgentId: "a", submissionId: "s", createdAt: "x" }] as never,
      currentVersionIdx: 1,
      currentContent: content,
    });

    expect(decision.kind).toBe("reply-result");
    if (decision.kind === "reply-result") expect(decision.markers[0].role).toBe("pong-result");
  });

  it("评论就写在 current 上时不重复高亮", () => {
    const decision = decideRightPane({ comment: comment(1, "保留的一段。"), replies: [], currentVersionIdx: 1, currentContent: content });

    expect(decision).toEqual({ kind: "same-version", markers: [] });
  });

  it("写在 current 上但已被回复时，仍走 reply-result 而不是 same-version", () => {
    const decision = decideRightPane({
      comment: comment(1, "保留的一段。"), // baseVersionIdx 1 === currentVersionIdx 1
      replies: [{
        replyIdx: 0,
        respondThroughCommentIdx: 0,
        resultLocations: [at("另一段。")],
        content: { text: "改好了", richContent: null, attachments: [] },
        authorAgentId: "a",
        submissionId: "s",
        createdAt: "x",
      }] as never,
      currentVersionIdx: 1,
      currentContent: content,
    });

    expect(decision.kind).toBe("reply-result");
  });

  it("基于旧版本且内容仍在时给灰底虚线", () => {
    const decision = decideRightPane({ comment: comment(0, "保留的一段。"), replies: [], currentVersionIdx: 1, currentContent: content });

    expect(decision.kind).toBe("stale-present");
    if (decision.kind === "stale-present") expect(decision.markers[0].role).toBe("stale-ping");
  });

  it("基于旧版本且原文已被改写时不高亮", () => {
    const decision = decideRightPane({
      comment: comment(0, "保留的一段。"), replies: [], currentVersionIdx: 1,
      currentContent: "# 标题\n\n全换了。\n",
    });

    expect(decision).toEqual({ kind: "stale-rewritten", markers: [] });
  });

  it("有回复但只回复、没有结果位置时仍按 reply-result 分支且 markers 为空", () => {
    const decision = decideRightPane({
      comment: comment(0, "保留的一段。"),
      replies: [{ replyIdx: 0, respondThroughCommentIdx: 0, resultLocations: [], content: { text: "解释", richContent: null, attachments: [] }, authorAgentId: "a", submissionId: "s", createdAt: "x" }] as never,
      currentVersionIdx: 1, currentContent: content,
    });

    expect(decision.kind).toBe("reply-result");
    if (decision.kind === "reply-result") expect(decision.markers).toEqual([]);
  });

  it("评论没有位置锚点时按 same-version 处理，不假装能高亮", () => {
    const decision = decideRightPane({
      comment: { ...comment(0, "保留的一段。"), location: null }, replies: [], currentVersionIdx: 1, currentContent: content,
    });

    expect(decision.kind).toBe("same-version");
    expect(decision.markers).toEqual([]);
  });

  // 问题 C1：resolveMarkdownTextRange 对非 Markdown 位置类型同样返回
  // { located: false, reason: "unsupported_type" }——修复前这条 unsupported_type
  // 和「内容确实已经不在了」的 unresolvable 走的是同一个 stale-rewritten 分支，
  // 会让 UI 对一个它根本判断不了的位置类型，说出「这段内容已经不在当前版本里」
  // 这句不知道真假的断言。这里换一种 host 不认识的 locationType（模拟未来的 PSD
  // 位置），断言不能落到 stale-rewritten，也不能在 markers 里假装找到了什么。
  it("位置类型不是 host 认识的 Markdown 文本区间时，不冒充「已改写」", () => {
    const decision = decideRightPane({
      comment: {
        ...comment(0, "保留的一段。"),
        location: { documentContractIdx: 0, locationType: "unidocs.psd.layer/v1", payload: { layerId: "l1" } },
      },
      replies: [],
      currentVersionIdx: 1,
      currentContent: content,
    });

    expect(decision.kind).not.toBe("stale-rewritten");
    expect(decision.kind).toBe("unsupported-location");
    expect(decision.markers).toEqual([]);
  });
});
