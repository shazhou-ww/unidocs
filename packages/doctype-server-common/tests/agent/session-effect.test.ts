import { describe, expect, it, vi } from "vitest";
import type {
  AgentCompletion, AgentPlatform, AgentTool, DocumentAgent, LlmMessage, SBlob, SBlobData, SValue,
} from "@unidocs/protocol";
import { createSBlob } from "@unidocs/svalue-codec";
import { AgentSession } from "../../src/agent/index.js";

type Q = { kind: string; payload?: Record<string, unknown> };
type O = { kind: string; payload: Record<string, unknown> };

function fakePlatform(over: Partial<AgentPlatform<Q, O>> = {}): AgentPlatform<Q, O> {
  return {
    query: vi.fn(async () => ({ data: { layers: [] } as SValue, version: 3 })),
    apply: vi.fn(async () => ({ version: 4 })),
    readBlob: vi.fn(async (): Promise<SBlobData> => ({ data: new Uint8Array([1, 2, 3]), contentType: "image/png" })),
    writeBlob: vi.fn(async (): Promise<SBlob> => createSBlob("a".repeat(64))),
    ...over,
  };
}

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

/** 记录 effect 拿到的 ctx，便于断言内核交给它的是什么。 */
function effectAgent(
  run: AgentTool<Q, O> extends { kind: "effect"; run: infer R } ? R : never,
): DocumentAgent<Q, O> {
  return {
    instructions: "测试用 operator。",
    tools: [{
      kind: "effect", name: "editPixels", description: "WRITE+IO.",
      inputSchema: { type: "object", properties: {} },
      run,
    }],
  };
}

const callEditPixels: AgentCompletion = {
  content: [], toolCalls: [{ id: "c1", name: "editPixels", arguments: { layerId: "L1" } }],
};
const done: AgentCompletion = { content: [{ type: "text", text: "好了" }] };

describe("effect 工具形态", () => {
  it("effect 产出的 ops 经 platform.apply 落地，description 用 outcome 的", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([callEditPixels, done]);
    const agent = effectAgent(async () => ({
      ops: [{ kind: "generative_fill", payload: { layerId: "L1" } }] as never,
      result: { structuredContent: { ok: true } },
      description: "editPixels: 删掉帽子",
    }));
    const s = new AgentSession({ agent, platform, provider });
    const out = await s.run([{ type: "text", text: "删帽子" }]);
    expect(out.ok).toBe(true);
    expect(platform.apply).toHaveBeenCalledWith(
      [{ kind: "generative_fill", payload: { layerId: "L1" } }],
      "editPixels: 删掉帽子",
    );
  });

  it("ops 为空数组时不调 apply —— 不产生 delta、不 bump 版本", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([callEditPixels, done]);
    const agent = effectAgent(async () => ({
      ops: [],
      result: { structuredContent: { ok: false, reason: "refused", detail: "内容审核未通过" } },
    }));
    const s = new AgentSession({ agent, platform, provider });
    await s.run([{ type: "text", text: "删帽子" }]);
    expect(platform.apply).not.toHaveBeenCalled();
    // 失败原样进历史，让模型自己决定改措辞重试
    const second = provider.seen[1];
    expect(second.at(-1)).toMatchObject({
      role: "tool", callId: "c1",
      structuredContent: { ok: false, reason: "refused", detail: "内容审核未通过" },
    });
  });

  it("EffectContext 暴露 query / readBlob / writeBlob / signal，不多不少", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([callEditPixels, done]);
    let keys: string[] = [];
    let aborted: boolean | null = null;
    const agent = effectAgent(async (_args, ctx) => {
      keys = Object.keys(ctx).sort();
      aborted = ctx.signal.aborted;
      await ctx.query({ kind: "getLayers" } as never);
      return { ops: [], result: { structuredContent: { ok: true } } };
    });
    await new AgentSession({ agent, platform, provider }).run([{ type: "text", text: "x" }]);
    expect(keys).toEqual(["query", "readBlob", "signal", "writeBlob"]);
    expect(aborted).toBe(false);
    expect(platform.query).toHaveBeenCalledWith({ kind: "getLayers" });
  });

  it("effect 抛错变成一条给模型的 tool 消息，循环不中断", async () => {
    const platform = fakePlatform();
    const provider = scriptedProvider([callEditPixels, done]);
    const agent = effectAgent(async () => { throw new Error("provider 挂了"); });
    const out = await new AgentSession({ agent, platform, provider }).run([{ type: "text", text: "x" }]);
    expect(out.ok).toBe(true);
    expect(provider.seen[1].at(-1)).toMatchObject({
      role: "tool", structuredContent: { error: "Error: provider 挂了" },
    });
  });
});
