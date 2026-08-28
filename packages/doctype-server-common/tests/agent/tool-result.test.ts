import { describe, expect, it } from "vitest";
import { createSBlob } from "@unidocs/svalue-codec";
import {
  defaultOpToolResult, defaultQueryToolResult, toolResultToMessage,
} from "../../src/agent/index.js";

const HASH = "a".repeat(64);

describe("默认的 SValue → AgentToolResult 转换", () => {
  it("query 默认包装成 { data, version }，与改造前 toolCall 的产物一致", () => {
    expect(defaultQueryToolResult({ layers: [] }, 7)).toEqual({
      structuredContent: { data: { layers: [] }, version: 7 },
    });
  });

  it("op 固定返回 { success: true, version }", () => {
    expect(defaultOpToolResult(8)).toEqual({
      structuredContent: { success: true, version: 8 },
    });
  });

  it("默认转换不产生 content —— 附件必须由 toResult 显式给出", () => {
    expect(defaultQueryToolResult({ a: 1 }, 1).content).toBeUndefined();
  });
});

describe("AgentToolResult → AgentMessage 的规范化", () => {
  it("content 与 structuredContent 原样搬，callId 由内核补", () => {
    const blob = createSBlob(HASH);
    const msg = toolResultToMessage("call-1", {
      structuredContent: { width: 10 },
      content: [{ type: "image", blob, mediaType: "image/png", altText: "preview" }],
    });
    expect(msg).toEqual({
      role: "tool",
      callId: "call-1",
      content: [{ type: "image", blob, mediaType: "image/png", altText: "preview" }],
      structuredContent: { width: 10 },
    });
  });

  it("没有 content 时归一成空数组，不是 undefined", () => {
    const msg = toolResultToMessage("call-2", { structuredContent: { ok: true } });
    expect(msg.content).toEqual([]);
  });

  it("没有 structuredContent 时该字段整个不出现", () => {
    const msg = toolResultToMessage("call-3", { content: [{ type: "text", text: "hi" }] });
    expect("structuredContent" in msg).toBe(false);
  });
});
