import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentPlatform, DocumentAgent } from "@unidocs/protocol";
import { AgentSession } from "../../src/agent/session.js";
import type { AgentRunOutcome, LlmProvider } from "../../src/agent/index.js";

/**
 * 只回一句话就收工的 provider：把它收到的 messages 记下来供断言。
 *
 * `content: [{ type: "text", text: "done" }]`，不是 `{ text: "done" }` ——
 * 后者曾经是这里的写法，但 `AgentCompletion`（protocol/src/types.ts:341）
 * 要的字段是 `content: readonly LlmContentPart[]`，没有 `text`。用错形状会
 * 让 `session.ts` 的 `completion.content.filter(...)` 在每一次 run 都抛
 * TypeError，被 `AgentSession.run()` 自己的 catch 折成 `{ok:false}` ——
 * 于是这个文件的六条测试全部只走失败路径，"assistant 消息完全不写进历史"
 * 这种改动也照样 6/6 全绿（2026-09-03 全分支评审 Important #4）。这里改对
 * 之后，下面每条调用 run() 的测试都显式断言 `outcome.ok === true`，不让
 * 同类回归再次无声无息地滑过去。
 */
function recordingProvider(): { provider: LlmProvider; seen: unknown[][] } {
  const seen: unknown[][] = [];
  return {
    seen,
    provider: {
      async complete(req: { messages: readonly unknown[] }) {
        seen.push([...req.messages]);
        return { content: [{ type: "text", text: "done" }], toolCalls: [] };
      },
    } as unknown as LlmProvider,
  };
}

/** 断言一次 run 真的成功了，不是被内核的 catch-all 兜成了失败结果。 */
function expectRunOk(outcome: AgentRunOutcome): void {
  expect(outcome.ok, "error" in outcome ? outcome.error : undefined).toBe(true);
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

    expectRunOk(await session.run([{ type: "text", text: "第二轮" }]));

    // 第一次模型调用收到的 messages 里必须含上一轮的两条。
    expect(JSON.stringify(seen[0])).toContain("第一轮问的");
    expect(JSON.stringify(seen[0])).toContain("第一轮答的");
  });

  it("不传 history 时行为与今天一致 —— 模型只看得见本轮", async () => {
    const { provider, seen } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider });

    expectRunOk(await session.run([{ type: "text", text: "只有这一轮" }]));

    expect(JSON.stringify(seen[0])).not.toContain("第一轮");
    expect(seen[0]).toHaveLength(1);
  });

  // 这条钉住的正是评审 Important #4 描述的检测力空洞:原断言只是
  // `snap.length >= 3`——2 条注入的 + 1 条 user 就已经是 3,哪怕
  // AgentSession 完全不再把 assistant 消息 push 进历史,这条也照样通过。
  // 现在断言的是确切长度(4 = 2 条注入 + 本轮 user + 本轮 assistant)以及
  // 最后一条确实是一条 assistant 消息、内容正是 provider 回的那句 ——
  // 不写进历史,这两条断言至少有一条会挂。
  it("snapshotHistory 返回本轮之后的完整历史,含新写入的 assistant 消息", async () => {
    const { provider } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });

    expectRunOk(await session.run([{ type: "text", text: "第二轮" }]));
    const snap = session.snapshotHistory();

    expect(snap.length).toBe(4);
    expect(JSON.stringify(snap)).toContain("第一轮问的");
    expect(JSON.stringify(snap)).toContain("第二轮");
    const last = snap[snap.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toEqual([{ type: "text", text: "done" }]);
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

    expectRunOk(await session.run([{ type: "text", text: "第二轮" }]));

    expect(caller).toHaveLength(2);
  });

  it("reset 之后 snapshotHistory 是空的", async () => {
    const { provider } = recordingProvider();
    const session = new AgentSession({ agent, platform, provider, history: priorTurn });
    session.reset();
    expect(session.snapshotHistory()).toEqual([]);
  });
});
