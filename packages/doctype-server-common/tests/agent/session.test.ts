import { describe, expect, it, vi } from "vitest";
import type {
  AgentCompletion, AgentPlatform, DocumentAgent, LlmMessage, SBlob, SBlobData, SValue,
} from "@unidocs/protocol";
import type { ObservedEvent } from "@unidocs/protocol-doc";
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

  // 光说"到上限了"对排查没用。一次真实故障里用户拿到的就是
  // `Max iterations (25) reached`，而 25 轮花在哪完全看不出来 —— 一直在找
  // 图层、一直在重画、某个工具每次都抛，这三种成因修法完全不同。
  it("达到 maxIterations 时把调用序列一起带出来，连续重复压成 xN", async () => {
    const call = { content: [], toolCalls: [{ id: "c1", name: "getLayers", arguments: {} }] };
    const provider = scriptedProvider([call, call, call]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider, maxIterations: 2 });
    const out = await s.run([{ type: "text", text: "x" }]);
    expect(out).toEqual({ ok: false, error: "Max iterations (2) reached. Tools called: getLayers x2" });
  });

  it("调用序列保留顺序，只压连续重复 —— 交替出现才是循环的样子", async () => {
    const look = { content: [], toolCalls: [{ id: "c1", name: "getPreview", arguments: {} }] };
    const list = { content: [], toolCalls: [{ id: "c2", name: "getLayers", arguments: {} }] };
    const provider = scriptedProvider([list, look, look, list]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider, maxIterations: 4 });
    const out = await s.run([{ type: "text", text: "x" }]);
    expect((out as { error: string }).error)
      .toBe("Max iterations (4) reached. Tools called: getLayers, getPreview x2, getLayers");
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

  it("一次 completion 里的多个 toolCall 各自生成一条独立的 tool 消息，顺序与 toolCalls 一致", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([
      {
        content: [],
        toolCalls: [
          { id: "c1", name: "getLayers", arguments: {} },
          { id: "c2", name: "transform", arguments: { layerId: "L1" } },
        ],
      },
      { content: [{ type: "text", text: "都做完了" }] },
    ]);
    const s = new AgentSession({ agent, platform, provider });
    await s.run([{ type: "text", text: "先看再改" }]);
    const historySent = provider.seen[1];
    const toolMessages = historySent.filter(m => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]).toEqual({
      role: "tool", callId: "c1", content: [],
      structuredContent: { data: { layers: [] }, version: 3 },
    });
    expect(toolMessages[1]).toEqual({
      role: "tool", callId: "c2", content: [],
      structuredContent: { success: true, version: 4 },
    });
  });

  it("既没 text 也没 tool_use 时以失败结束，空 assistant 消息不进历史", async () => {
    const provider = scriptedProvider([
      { content: [], toolCalls: undefined, stopReason: "max_tokens" },
      { content: [{ type: "text", text: "这次说话了" }] },
    ]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });

    const first = await s.run([{ type: "text", text: "第一句" }]);
    expect(first).toEqual({ ok: false, error: "模型没有返回可用内容（stop_reason: max_tokens）" });

    // 关键断言：同一个 session 再跑一次。那条空 assistant 一旦留在历史里，
    // 此后每次 run 都会把 {role:"assistant", content:[]} 发出去，Anthropic
    // 拒收空 content —— 会话从此只能靠 reset 救活。
    const second = await s.run([{ type: "text", text: "第二句" }]);
    expect(second.ok).toBe(true);
    const sent = provider.seen[1];
    expect(sent.filter(m => m.role === "assistant")).toEqual([]);
    expect(sent).toEqual([
      { role: "user", content: [{ type: "text", text: "第一句" }] },
      { role: "user", content: [{ type: "text", text: "第二句" }] },
    ]);
  });

  it("provider 没报 stop_reason 时错误里写「未知」，不写 undefined", async () => {
    const provider = scriptedProvider([{ content: [] }]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider });
    const out = await s.run([{ type: "text", text: "x" }]);
    expect(out).toEqual({ ok: false, error: "模型没有返回可用内容（stop_reason: 未知）" });
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

/**
 * agent 运行过程的观测。
 *
 * 这一族是被一次真实故障逼出来的：agent 跑了 64 秒，两次图像调用都成功，然后
 * 整个请求以 `internal error; reference = …` 收场。日志里只有那两条出站 HTTP
 * —— 调了哪些工具、跑了几轮、在第几步崩的，一个字都没有。成因是模型调用和
 * 消息实体化不在任何 try 里，异常直接穿出 DO 被 Cloudflare 包成不透明 500。
 */
describe("AgentSession 观测", () => {
  const collect = () => { const seen: ObservedEvent[] = []; return { seen, observe: (e: ObservedEvent) => seen.push(e) }; };
  const kinds = (seen: ObservedEvent[]) => seen.map(e => (e.event === "agent_step" ? `${e.event}:${e.kind}` : `${e.event}:${(e as { phase: string }).phase}`));

  it("一次干净的 run 产出 start / llm / tool / llm / end", async () => {
    const { seen, observe } = collect();
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "getLayers", arguments: {} }] },
      { content: [{ type: "text", text: "好了" }] },
    ]);
    const s = new AgentSession({ agent, platform: fakePlatform(), provider, observe, docType: "psd" });
    await s.run([{ type: "text", text: "x" }]);
    expect(kinds(seen)).toEqual([
      "agent_run:start", "agent_step:llm", "agent_step:tool", "agent_step:llm", "agent_run:end",
    ]);
    const end = seen.at(-1) as { ok: boolean; iterations: number; tools: string; docType: string };
    expect(end).toMatchObject({ ok: true, iterations: 2, tools: "getLayers", docType: "psd" });
  });

  it("工具失败记成 ok:false 并带上错误 —— #dispatch 从不抛，只能从结果里读", async () => {
    // 靠 try/catch 判断这一步成不成会把每一次工具失败都显示成成功。
    const { seen, observe } = collect();
    const platform = fakePlatform({ apply: vi.fn(async () => { throw new Error("layer not found: L9"); }) });
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "transform", arguments: {} }] },
      { content: [{ type: "text", text: "换一个" }] },
    ]);
    await new AgentSession({ agent, platform, provider, observe }).run([{ type: "text", text: "x" }]);
    const tool = seen.find(e => e.event === "agent_step" && e.kind === "tool") as { ok: boolean; error: string; name: string };
    expect(tool.ok).toBe(false);
    expect(tool.name).toBe("transform");
    expect(tool.error).toContain("layer not found: L9");
  });

  it("工具调用记下参数摘要 —— 只记名字回答不了「它编辑的是哪一层」", async () => {
    // 一次真实排查卡在这里：日志能看出 agent 调了 editPixels，却看不出目标图层,
    // 而"它为什么没改用 setText"完全取决于那层是不是可编辑的文字层。
    const { seen, observe } = collect();
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "transform", arguments: { layerId: "L7", op: { translate: [3, 4] } } }] },
      { content: [{ type: "text", text: "好了" }] },
    ]);
    await new AgentSession({ agent, platform: fakePlatform(), provider, observe }).run([{ type: "text", text: "x" }]);
    const tool = seen.find(e => e.event === "agent_step" && e.kind === "tool") as { args: string };
    expect(tool.args).toContain("L7");
  });

  it("超长参数被截断 —— editPixels 带自然语言指令,全记会把日志淹掉", async () => {
    const { seen, observe } = collect();
    const long = "改成蓝色".repeat(200);
    const provider = scriptedProvider([
      { content: [], toolCalls: [{ id: "c1", name: "transform", arguments: { layerId: "L7", instruction: long } }] },
      { content: [{ type: "text", text: "好了" }] },
    ]);
    await new AgentSession({ agent, platform: fakePlatform(), provider, observe }).run([{ type: "text", text: "x" }]);
    const tool = seen.find(e => e.event === "agent_step" && e.kind === "tool") as { args: string };
    // 定位字段在前面,所以截断之后仍然找得到 layerId —— 这正是截断点选在
    // 参数序列化的开头而不是结尾的理由。
    expect(tool.args).toContain("L7");
    expect(tool.args.length).toBeLessThan(long.length);
    expect(tool.args).toMatch(/…\(\+\d+\)$/);
  });

  it("模型调用抛异常时以普通失败结束，并记下 error 和栈 —— 而不是穿出去变成不透明 500", async () => {
    const { seen, observe } = collect();
    const boom = Object.assign(new Error("payload too large"), { cause: new Error("413 from upstream") });
    const provider = { seen: [], complete: vi.fn(async () => { throw boom; }) };
    const out = await new AgentSession({ agent, platform: fakePlatform(), provider: provider as never, observe })
      .run([{ type: "text", text: "x" }]);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain("payload too large");
    // cause 也要展开：底层原因常被藏在外层那句话里面
    expect((out as { error: string }).error).toContain("413 from upstream");
    const failed = seen.find(e => e.event === "agent_step" && !e.ok) as { error: string; stack?: string };
    expect(failed.error).toContain("payload too large");
    expect(failed.stack).toBeTruthy();
    // 即使崩了，end 事件也必须有 —— 否则日志里一次 run 有头无尾
    expect(kinds(seen).at(-1)).toBe("agent_run:end");
  });

  it("到达上限时 end 事件带上完整调用序列", async () => {
    const { seen, observe } = collect();
    const call = { content: [], toolCalls: [{ id: "c1", name: "getLayers", arguments: {} }] };
    const provider = scriptedProvider([call, call, call]);
    await new AgentSession({ agent, platform: fakePlatform(), provider, observe, maxIterations: 2 })
      .run([{ type: "text", text: "x" }]);
    expect(seen.at(-1)).toMatchObject({ event: "agent_run", phase: "end", ok: false, tools: "getLayers x2" });
  });

  it("不注入 observe 就一条都不产出 —— 既有调用方与单测行为不变", async () => {
    const provider = scriptedProvider([{ content: [{ type: "text", text: "ok" }] }]);
    const out = await new AgentSession({ agent, platform: fakePlatform(), provider }).run([{ type: "text", text: "x" }]);
    expect(out.ok).toBe(true);
  });
});
