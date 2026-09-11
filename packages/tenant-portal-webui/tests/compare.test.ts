import { describe, expect, it } from "vitest";
import { createMarkdownTextRange } from "@unidocs/tenant-portal-client";
import { decideRightPane } from "../src/model/compare.js";

const content = "# 标题\n\n保留的一段。\n\n另一段。\n";
const at = (quote: string) =>
  createMarkdownTextRange({ documentContractIdx: 0, content, start: content.indexOf(quote), end: content.indexOf(quote) + quote.length });

const ping = (baseVersionIdx: number, quote: string) => ({
  pingIdx: 0, baseVersionIdx, location: at(quote),
  content: { text: "c", richContent: null, attachments: [] }, authorId: "u", createdAt: "x",
});

describe("decideRightPane", () => {
  it("有覆盖该 ping 的 pong 时金色高亮结果位置", () => {
    const decision = decideRightPane({
      ping: ping(0, "保留的一段。"),
      pongs: [{ pongIdx: 0, respondThroughPingIdx: 0, resultLocations: [at("另一段。")], content: { text: "改好了", richContent: null, attachments: [] }, authorAgentId: "a", submissionId: "s", createdAt: "x" }] as never,
      currentVersionIdx: 1,
      currentContent: content,
    });

    expect(decision.kind).toBe("pong-result");
    if (decision.kind === "pong-result") expect(decision.markers[0].role).toBe("pong-result");
  });

  it("ping 就写在 current 上时不重复高亮", () => {
    const decision = decideRightPane({ ping: ping(1, "保留的一段。"), pongs: [], currentVersionIdx: 1, currentContent: content });

    expect(decision).toEqual({ kind: "same-version", markers: [] });
  });

  it("写在 current 上但已被回复时，仍走 pong-result 而不是 same-version", () => {
    const decision = decideRightPane({
      ping: ping(1, "保留的一段。"), // baseVersionIdx 1 === currentVersionIdx 1
      pongs: [{
        pongIdx: 0,
        respondThroughPingIdx: 0,
        resultLocations: [at("另一段。")],
        content: { text: "改好了", richContent: null, attachments: [] },
        authorAgentId: "a",
        submissionId: "s",
        createdAt: "x",
      }] as never,
      currentVersionIdx: 1,
      currentContent: content,
    });

    expect(decision.kind).toBe("pong-result");
  });

  it("基于旧版本且内容仍在时给灰底虚线", () => {
    const decision = decideRightPane({ ping: ping(0, "保留的一段。"), pongs: [], currentVersionIdx: 1, currentContent: content });

    expect(decision.kind).toBe("stale-present");
    if (decision.kind === "stale-present") expect(decision.markers[0].role).toBe("stale-ping");
  });

  it("基于旧版本且原文已被改写时不高亮", () => {
    const decision = decideRightPane({
      ping: ping(0, "保留的一段。"), pongs: [], currentVersionIdx: 1,
      currentContent: "# 标题\n\n全换了。\n",
    });

    expect(decision).toEqual({ kind: "stale-rewritten", markers: [] });
  });

  it("有 pong 但只回复、没有结果位置时仍按 pong-result 分支且 markers 为空", () => {
    const decision = decideRightPane({
      ping: ping(0, "保留的一段。"),
      pongs: [{ pongIdx: 0, respondThroughPingIdx: 0, resultLocations: [], content: { text: "解释", richContent: null, attachments: [] }, authorAgentId: "a", submissionId: "s", createdAt: "x" }] as never,
      currentVersionIdx: 1, currentContent: content,
    });

    expect(decision.kind).toBe("pong-result");
    if (decision.kind === "pong-result") expect(decision.markers).toEqual([]);
  });

  it("ping 没有位置锚点时按 same-version 处理，不假装能高亮", () => {
    const decision = decideRightPane({
      ping: { ...ping(0, "保留的一段。"), location: null }, pongs: [], currentVersionIdx: 1, currentContent: content,
    });

    expect(decision.kind).toBe("same-version");
    expect(decision.markers).toEqual([]);
  });
});
