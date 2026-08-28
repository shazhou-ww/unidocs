import { describe, expect, it, vi } from "vitest";
import type {
  AgentCompletion, AgentPlatform, DocumentAgent, LlmMessage, SBlob, SBlobData, SValue,
} from "@unidocs/protocol";
import { AgentSession } from "../../src/agent/index.js";

type Q = { kind: string; payload?: Record<string, unknown> };
type O = { kind: string; payload: Record<string, unknown> };

const agent: DocumentAgent<Q, O> = {
  instructions: "你是测试用的 operator。",
  tools: [
    {
      kind: "query", name: "getLayers", description: "READ.",
      inputSchema: { type: "object", properties: {} },
      toQuery: () => ({ kind: "getLayers" }) as never,
    },
    {
      kind: "op", name: "transform", description: "WRITE.",
      inputSchema: { type: "object", properties: {} },
      toOps: args => [{ kind: "transform", payload: args }] as never,
    },
  ],
};

function fakePlatform(over: Partial<AgentPlatform<Q, O>> = {}): AgentPlatform<Q, O> {
  return {
    query: vi.fn(async () => ({ data: { layers: [] } as SValue, version: 3 })),
    apply: vi.fn(async () => ({ version: 4 })),
    readBlob: vi.fn(async (): Promise<SBlobData> => ({ data: new Uint8Array(), contentType: "image/png" })),
    writeBlob: vi.fn(async (): Promise<SBlob> => { throw new Error("unused"); }),
    ...over,
  };
}

/** 依次返回预设的 completion，并记下每次收到的 messages。 */
function scriptedProvider(script: AgentCompletion[]) {
  const seen: LlmMessage[][] = [];
  let i = 0;
  return {
    seen,
    complete: vi.fn(async (req: { messages: readonly LlmMessage[] }) => {
      seen.push([...req.messages]);
      const next = script[i++];
      if (!next) throw new Error("provider script exhausted");
      return next;
    }),
  };
}

describe("AgentSession 循环", () => {
  it("模型不调工具就直接结束，iterations = 1", async () => {
    const provider = scriptedProvider([{ content: [{ type: "text", text: "好了" }] }]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });
    const out = await s.run([{ type: "text", text: "看一下" }]);
    expect(out).toEqual({ ok: true, content: [{ type: "text", text: "好了" }], response: "好了", iterations: 1 });
  });

  it("query 工具走 toQuery → platform.query → 默认转换", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "getLayers", arguments: {} }] },
      { content: [{ type: "text", text: "看完了" }] },
    ]);
    const s = new AgentSession({ agent, platform, provider });
    await s.run([{ type: "text", text: "列图层" }]);
    expect(platform.query).toHaveBeenCalledWith({ kind: "getLayers" });
    // 第二次调模型时，工具结果已经作为 role:"tool" 进了历史
    const second = provider.seen[1];
    expect(second.at(-1)).toEqual({
      role: "tool", callId: "c1", content: [],
      structuredContent: { data: { layers: [] }, version: 3 },
    });
  });

  it("op 工具走 toOps → platform.apply，描述带工具名", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "transform", arguments: { layerId: "L1" } }] },
      { content: [{ type: "text", text: "改完了" }] },
    ]);
    const s = new AgentSession({ agent, platform, provider });
    await s.run([{ type: "text", text: "移动图层" }]);
    expect(platform.apply).toHaveBeenCalledWith(
      [{ kind: "transform", payload: { layerId: "L1" } }],
      "Agent: transform",
    );
    expect(provider.seen[1].at(-1)).toMatchObject({
      structuredContent: { success: true, version: 4 },
    });
  });

  it("apply 失败时错误原文回给模型，循环不中断（spec 5.2）", async () => {
    const platform = fakePlatform({
      apply: vi.fn(async () => { throw new Error("layer not found: L9"); }),
    });
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "transform", arguments: { layerId: "L9" } }] },
      { content: [{ type: "text", text: "换一个" }] },
    ]);
    const s = new AgentSession({ agent, platform, provider });
    const out = await s.run([{ type: "text", text: "移动" }]);
    expect(out.ok).toBe(true);
    expect(JSON.stringify(provider.seen[1].at(-1))).toContain("layer not found: L9");
  });

  it("未知工具名返回错误文本给模型，循环不中断", async () => {
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "nope", arguments: {} }] },
      { content: [{ type: "text", text: "抱歉" }] },
    ]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });
    const out = await s.run([{ type: "text", text: "x" }]);
    expect(out.ok).toBe(true);
    expect(JSON.stringify(provider.seen[1].at(-1))).toContain("nope");
  });

  it("达到 maxIterations 以失败结束", async () => {
    const call = { content: [], toolCalls: [{ id: "c1", name: "getLayers", arguments: {} }] };
    const provider = scriptedProvider([call, call, call]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider, maxIterations: 2 });
    const out = await s.run([{ type: "text", text: "x" }]);
    expect(out).toEqual({ ok: false, error: "Max iterations (2) reached" });
  });

  it("提示词作为 system 传给 provider，不混进 messages", async () => {
    const provider = scriptedProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });
    await s.run([{ type: "text", text: "x" }]);
    expect(provider.complete.mock.calls[0][0].system).toBe(agent.instructions);
    expect(provider.seen[0].every(m => m.role !== ("system" as never))).toBe(true);
  });

  it("内核不持有版本状态：不先 query 直接 apply 也放行（spec 5.2）", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "transform", arguments: {} }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const s = new AgentSession({ agent, platform, provider });
    const out = await s.run([{ type: "text", text: "x" }]);
    expect(out.ok).toBe(true);
    expect(platform.query).not.toHaveBeenCalled();
  });

  it("reset 之后模型看不到上一轮", async () => {
    const provider = scriptedProvider([
      { content: [{ type: "text", text: "a" }] },
      { content: [{ type: "text", text: "b" }] },
    ]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });
    await s.run([{ type: "text", text: "第一句" }]);
    s.reset();
    await s.run([{ type: "text", text: "第二句" }]);
    expect(provider.seen[1]).toHaveLength(1);
  });
});
