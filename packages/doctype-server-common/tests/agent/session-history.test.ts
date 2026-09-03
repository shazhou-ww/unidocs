import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentPlatform, DocumentAgent } from "@unidocs/protocol";
import { AgentSession } from "../../src/agent/session.js";
import type { LlmProvider } from "../../src/agent/index.js";

/** 只回一句话就收工的 provider：把它收到的 messages 记下来供断言。 */
function recordingProvider(): { provider: LlmProvider; seen: unknown[][] } {
  const seen: unknown[][] = [];
  return {
    seen,
    provider: {
      async complete(req: { messages: readonly unknown[] }) {
        seen.push([...req.messages]);
        return { text: "done", toolCalls: [] };
      },
    } as unknown as LlmProvider,
  };
}

const agent: DocumentAgent<unknown, unknown> = { tools: [], instructions: "sys" };

const platform = {
  query: async () => ({ data: null, version: 0 }),
  apply: async () => ({ version: 1 }),
  readBlob: async () => ({ data: new Uint8Array(), contentType: "application/octet-stream" }),
  writeBlob: async () => { throw new Error("unused"); },
} as unknown as AgentPlatform<unknown, unknown>;

const priorTurn: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "第一轮问的" }] },
  { role: "assistant", content: [{ type: "text", text: "第一轮答的" }] },
];

describe("AgentSession 的历史进出口", () => {
  it("传入 history 就能续上对话 —— 模型看得见上一轮", async () => {
    const { provider, seen } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });

    await session.run([{ type: "text", text: "第二轮" }]);

    // 第一次模型调用收到的 messages 里必须含上一轮的两条。
    expect(JSON.stringify(seen[0])).toContain("第一轮问的");
    expect(JSON.stringify(seen[0])).toContain("第一轮答的");
  });

  it("不传 history 时行为与今天一致 —— 模型只看得见本轮", async () => {
    const { provider, seen } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider });

    await session.run([{ type: "text", text: "只有这一轮" }]);

    expect(JSON.stringify(seen[0])).not.toContain("第一轮");
    expect(seen[0]).toHaveLength(1);
  });

  it("snapshotHistory 返回本轮之后的完整历史", async () => {
    const { provider } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });

    await session.run([{ type: "text", text: "第二轮" }]);
    const snap = session.snapshotHistory();

    expect(snap.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(snap)).toContain("第一轮问的");
    expect(JSON.stringify(snap)).toContain("第二轮");
  });

  // 交出内部数组会让调用方在写回之前不小心改坏历史，而这种 bug 只在
  // "下一次 run 读到脏历史"时才暴露，离现场很远。
  it("snapshotHistory 给的是副本，改它不影响内部", async () => {
    const { provider } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });

    const snap = session.snapshotHistory() as AgentMessage[];
    snap.length = 0;

    expect(session.snapshotHistory()).toHaveLength(2);
  });

  // 构造时也要复制：调用方手上的那个数组不该随 run 增长。
  it("传进来的 history 被复制，调用方的数组不会被 run 改动", async () => {
    const { provider } = recordingProvider();
    const caller = [...priorTurn];
    const session = new AgentSession({ agent, platform, provider, history: caller });

    await session.run([{ type: "text", text: "第二轮" }]);

    expect(caller).toHaveLength(2);
  });

  it("reset 之后 snapshotHistory 是空的", async () => {
    const { provider } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });
    session.reset();
    expect(session.snapshotHistory()).toEqual([]);
  });
});
