import { describe, expect, it, vi } from "vitest";
import { LlmWaitHeartbeatMs } from "@unidocs/protocol-doc";
import type { ObservedEvent } from "@unidocs/protocol-doc";
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

  it("stop_reason 原样带回 completion —— 只思考没说话时它是唯一的线索", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      content: [],
      stop_reason: "max_tokens",
    }), { status: 200 }));
    const provider = createAnthropicProvider({ LLM_API_KEY: "k" }, fetchImpl as never);
    const completion = await provider.complete({ system: "", messages: [], tools: [] });
    expect(completion.content).toEqual([]);
    expect(completion.toolCalls).toBeUndefined();
    expect(completion.stopReason).toBe("max_tokens");
  });

  it("默认模型和 max_tokens 是当前在用的那一对", async () => {
    let body: any;
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ content: [] }), { status: 200 });
    });
    const provider = createAnthropicProvider({ LLM_API_KEY: "k" }, fetchImpl as never);
    await provider.complete({ system: "", messages: [], tools: [] });
    expect(body.model).toBe("claude-opus-5");
    expect(body.max_tokens).toBe(16000);
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

/**
 * 对模型的调用曾是系统里**唯一**不产 http_call 的出站调用，而且没有超时。
 *
 * 一次真实故障：第一轮调用发出去就挂住，300.3 秒后 workerd 掐掉连接抛
 * `Network connection lost.`，用户等五分钟换回一个 500，日志里连它打去了哪个
 * 地址都看不到。CAS、doc worker、DashScope 都有观测，唯独这里没有。
 */
describe("Anthropic provider 的超时与观测", () => {
  // key 要有辨识度：用单字母的话，"不含 key"这条断言会被 "http_call" 里的
  // 字母顺手满足，测不出任何东西。
  const SECRET = "sk-do-not-log-me-9f3a";
  const env = { LLM_API_KEY: SECRET, LLM_BASE_URL: "https://llm.example/v1/messages", LLM_MODEL: "m" };
  const okBody = { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" };
  const collect = () => {
    const seen: ObservedEvent[] = [];
    // 结果事件不再是第 0 条:`llm_call:start` 排在它前面(调用发出之前就得落盘)。
    // 按事件名取,这样以后再往前面加事件也不会把断言弄坏。
    const http = () => seen.find(e => e.event === "http_call");
    return { seen, http, observe: (e: ObservedEvent) => seen.push(e) };
  };

  it("成功时记一条 http_call 简报，且不泄露 x-api-key", async () => {
    const { seen, http, observe } = collect();
    const f = vi.fn(async () => Response.json(okBody)) as unknown as typeof fetch;
    await createAnthropicProvider(env, f, { observe }).complete({ system: "s", messages: [], tools: [] });
    const e = http() as unknown as { event: string; target: string; op: string; status: number; ok: boolean };
    expect(e).toMatchObject({ event: "http_call", target: "llm", op: "complete", status: 200, ok: true });
    expect(JSON.stringify(seen)).not.toContain("x-api-key");
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });

  it("非 2xx 记下状态码和响应体", async () => {
    const { http, observe } = collect();
    const f = vi.fn(async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await expect(createAnthropicProvider(env, f, { observe }).complete({ system: "", messages: [], tools: [] }))
      .rejects.toThrow("429");
    expect(http()).toMatchObject({ event: "http_call", status: 429, ok: false, responseBody: "rate limited" });
  });

  it("超时以可读的错误结束，并记一条 status 0 的失败事件（带栈）", async () => {
    const { http, observe } = collect();
    // 永不 resolve —— 只有 signal 能把它结束掉。
    const f = vi.fn((_u: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new DOMException("signal timed out", "TimeoutError")));
    })) as unknown as typeof fetch;
    const p = createAnthropicProvider(env, f, { observe, timeoutMs: 20 })
      .complete({ system: "", messages: [], tools: [] });
    // 错误里要有"等了多久"和"打给谁"——TimeoutError 那句原话对排查没有信息量
    await expect(p).rejects.toThrow(/did not respond within 20ms/);
    await expect(p).rejects.toThrow(/llm\.example/);
    expect(http()).toMatchObject({ event: "http_call", status: 0, ok: false });
    expect((http() as unknown as { error: string }).error).toContain("TimeoutError");
  });

  it("发出去之前先记一条 llm_call:start，带上真实发出去的形状", async () => {
    const { seen, observe } = collect();
    const f = vi.fn(async () => Response.json(okBody)) as unknown as typeof fetch;
    const png = new Uint8Array([1, 2, 3]);
    await createAnthropicProvider(env, f, { observe }).complete({
      system: "s",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "tool", callId: "c1", content: [{ type: "image", data: png, mediaType: "image/png" }] },
      ],
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    });
    // 顺序也是契约:start 必须在结果事件之前 —— 它的全部价值就是"卡住时也已经落盘"。
    expect(seen[0]).toMatchObject({
      event: "llm_call", phase: "start", model: "m", messages: 2, images: 1, tools: 1,
    });
    expect((seen[0] as { requestChars: number }).requestChars).toBeGreaterThan(0);
    expect(seen[1]).toMatchObject({ event: "http_call", target: "llm" });
  });

  it("等待期间按心跳**反复**产 llm_call:wait —— 它是「还活着」与「卡死了」的唯一区分器", async () => {
    const { seen, observe } = collect();
    let release!: (r: Response) => void;
    const f = (() => new Promise<Response>((res) => { release = res; })) as unknown as typeof fetch;
    // 真实时钟、极短间隔。假时钟跨挂起的异步帧不给 interval 续期,断言不出
    // "反复触发"——而只响一次的心跳对排查毫无用处,这正是要测的那一点。
    const p = createAnthropicProvider(env, f, { observe, heartbeatMs: 5 })
      .complete({ system: "", messages: [], tools: [] });
    const waits = () => seen.filter(e => e.event === "llm_call" && (e as { phase: string }).phase === "wait");
    await vi.waitUntil(() => waits().length >= 3, { timeout: 1000, interval: 5 });
    expect((waits()[2] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(10);
    release(Response.json(okBody));
    await p;
    // 拿到结果之后必须停 —— 留着的 interval 会一直往日志里灌。
    const settled = waits().length;
    await new Promise(r => setTimeout(r, 50));
    expect(waits().length).toBe(settled);
  });

  it("ttfbMs 与 durationMs 分开 —— 「回得慢」和「想得久」是两回事", async () => {
    const { seen, observe } = collect();
    // 响应头立刻到,响应体拖 50ms。ttfb 应当明显小于总耗时。
    const f = vi.fn(async () => new Response(
      new ReadableStream({
        start(c) {
          setTimeout(() => {
            c.enqueue(new TextEncoder().encode(JSON.stringify(okBody)));
            c.close();
          }, 50);
        },
      }),
      { headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    await createAnthropicProvider(env, f, { observe }).complete({ system: "", messages: [], tools: [] });
    const e = seen.find(x => x.event === "http_call") as { ttfbMs: number; durationMs: number };
    expect(e.durationMs).toBeGreaterThanOrEqual(50);
    expect(e.ttfbMs).toBeLessThan(e.durationMs);
  });

  it("不注入 observe 时一条都不产 —— 既有调用方行为不变", async () => {
    const f = vi.fn(async () => Response.json(okBody)) as unknown as typeof fetch;
    const out = await createAnthropicProvider(env, f).complete({ system: "", messages: [], tools: [] });
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
  });
});
