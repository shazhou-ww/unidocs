import { describe, expect, it } from "vitest";
import type {
  AgentMessage, AgentTool, DocumentAgent, LlmMessage,
} from "../src/index.js";

type Q = { kind: string; payload?: Record<string, unknown> };
type O = { kind: string; payload: Record<string, unknown> };

describe("agent 上边界契约", () => {
  it("query 工具只声明纯函数，不接受任何句柄", () => {
    const tool: AgentTool<Q, O> = {
      kind: "query",
      name: "getLayers",
      description: "READ.",
      inputSchema: { type: "object", properties: {} },
      toQuery: () => ({ kind: "getLayers" }) as never,
    };
    expect(tool.kind).toBe("query");
    // 同一组参数调两次结果深相等 —— 纯函数（spec V7）
    expect(tool.toQuery({})).toEqual(tool.toQuery({}));
  });

  it("op 工具产出一批 op，且没有 toResult", () => {
    const tool: AgentTool<Q, O> = {
      kind: "op",
      name: "transform",
      description: "WRITE.",
      inputSchema: { type: "object", properties: {} },
      toOps: args => [{ kind: "transform", payload: args }] as never,
    };
    expect(tool.kind).toBe("op");
    expect("toResult" in tool).toBe(false);
  });

  it("DocumentAgent 就是一张表加一段提示词", () => {
    const agent: DocumentAgent<Q, O> = { tools: [], instructions: "hi" };
    expect(agent.tools).toEqual([]);
    expect(Object.keys(agent).sort()).toEqual(["instructions", "tools"]);
  });

  it("三个 role 的持久消息都用同一种 content", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }], toolCalls: [{ id: "t1", name: "getLayers", arguments: {} }] },
      { role: "tool", callId: "t1", content: [], structuredContent: { ok: true } },
    ];
    for (const m of msgs) expect(Array.isArray(m.content)).toBe(true);
  });

  it("模型态的附件是字节，持久态的是 SBlob", () => {
    const llm: LlmMessage = {
      role: "user",
      content: [{ type: "image", data: new Uint8Array([1, 2]), mediaType: "image/png" }],
    };
    const part = llm.content[0];
    expect(part.type === "image" && part.data).toBeInstanceOf(Uint8Array);
  });
});
