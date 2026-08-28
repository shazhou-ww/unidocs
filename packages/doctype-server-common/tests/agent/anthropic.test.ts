import { describe, expect, it, vi } from "vitest";
import type { LlmMessage } from "@unidocs/protocol";
import { createAnthropicProvider, toAnthropicMessages } from "../../src/agent/index.js";

describe("中立消息 → Anthropic", () => {
  it("图片直接读 image part，不做任何搜索", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: "看这个" }] },
      { role: "assistant", content: [], toolCalls: [{ id: "c1", name: "getPreview", arguments: {} }] },
      {
        role: "tool", callId: "c1",
        content: [
          { type: "image", data: new Uint8Array([1, 2, 3]), mediaType: "image/png", altText: "preview 8x8 v3" },
          { type: "text", text: "[preview]" },
        ],
        structuredContent: { width: 8 },
      },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "看这个" }] });
    expect(out[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "getPreview", input: {} }],
    });
    const toolResult = out[2].content[0];
    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
    expect(toolResult.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
    });
  });

  it("同一个 assistant 轮次的多个 tool 结果合并进一条 user 消息", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [], toolCalls: [
        { id: "c1", name: "a", arguments: {} }, { id: "c2", name: "b", arguments: {} },
      ] },
      { role: "tool", callId: "c1", content: [{ type: "text", text: "1" }] },
      { role: "tool", callId: "c2", content: [{ type: "text", text: "2" }] },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(2);
    expect(out[1].content).toHaveLength(2);
  });

  it("structuredContent 作为文字块跟在附件后面", () => {
    const out = toAnthropicMessages([
      { role: "tool", callId: "c1", content: [], structuredContent: { ok: true } },
    ]);
    expect(out[0].content[0].content).toEqual([{ type: "text", text: '{"ok":true}' }]);
  });
});

describe("Anthropic 响应 → AgentCompletion", () => {
  it("文字和 tool_use 各自归位", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      content: [
        { type: "text", text: "我来看看" },
        { type: "tool_use", id: "c1", name: "getLayers", input: { a: 1 } },
      ],
    }), { status: 200 }));
    const provider = createAnthropicProvider({ LLM_API_KEY: "k" }, fetchImpl as never);
    const completion = await provider.complete({
      system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [],
    });
    expect(completion.content).toEqual([{ type: "text", text: "我来看看" }]);
    expect(completion.toolCalls).toEqual([{ id: "c1", name: "getLayers", arguments: { a: 1 } }]);
  });

  it("system 走顶层字段", async () => {
    let body: any;
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ content: [] }), { status: 200 });
    });
    const provider = createAnthropicProvider({ LLM_API_KEY: "k" }, fetchImpl as never);
    await provider.complete({ system: "你是 operator", messages: [], tools: [] });
    expect(body.system).toBe("你是 operator");
  });

  it("没有 API key 时报出可操作的错误", async () => {
    const provider = createAnthropicProvider({});
    await expect(provider.complete({ system: "", messages: [], tools: [] }))
      .rejects.toThrow(/LLM_API_KEY/);
  });

  it("非 2xx 带上状态码和响应体", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    const provider = createAnthropicProvider({ LLM_API_KEY: "k" }, fetchImpl as never);
    await expect(provider.complete({ system: "", messages: [], tools: [] }))
      .rejects.toThrow("Anthropic 429: nope");
  });
});
