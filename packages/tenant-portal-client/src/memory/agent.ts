/**
 * 假后端里的 Agent。协议上 Agent 通过原子 submission 工作；这里只模拟用户可见的
 * 结果——ping 写入后产出一条 pong，把水位推到当前最新 ping，可选地产生新版本。
 *
 * 同步驱动：不用定时器，测试调 runPending() 明确推进。
 */
import type { DocumentLocation, PongRecord } from "@unidocs/protocol-platform";
import type { MemoryStore } from "./store.js";
import { isOpen } from "./store.js";

export interface AgentReply {
  readonly text: string;
  /** 省略则为纯 pong：只回复，不产生新版本。 */
  readonly producesContent?: string;
  /** 相对于新版本的位置；纯 pong 应为空。 */
  readonly resultLocations?: readonly DocumentLocation[];
}

export interface AgentContext {
  readonly documentId: string;
  readonly threadId: string;
  readonly latestPingIdx: number;
  readonly latestPingText: string | null;
}

export interface ScriptedAgent {
  pendingCount(): number;
  /** 处理所有待回复的一处，返回处理了几处。 */
  runPending(): number;
}

const defaultRespond = (context: AgentContext): AgentReply => ({
  text: `已处理到第 ${context.latestPingIdx + 1} 条评论。`,
});

export function createScriptedAgent(options: {
  store: MemoryStore;
  respond?: (context: AgentContext) => AgentReply;
}): ScriptedAgent {
  const { store } = options;
  const respond = options.respond ?? defaultRespond;

  function pending(): { documentId: string; threadId: string }[] {
    const result: { documentId: string; threadId: string }[] = [];
    for (const [documentId, state] of store.documents) {
      for (const [threadId, record] of state.threads) {
        if (isOpen(record)) result.push({ documentId, threadId });
      }
    }
    return result;
  }

  return {
    pendingCount: () => pending().length,

    runPending: () => {
      const work = pending();
      for (const { documentId, threadId } of work) {
        const state = store.requireDocument(documentId);
        const record = state.threads.get(threadId);
        if (record === undefined) continue;

        const latest = record.pings[record.pings.length - 1];
        const reply = respond({
          documentId,
          threadId,
          latestPingIdx: latest.pingIdx,
          latestPingText: latest.content.text,
        });

        if (reply.producesContent !== undefined) {
          store.appendVersion(state, reply.producesContent, "agent:scripted");
        }

        const pong: PongRecord = {
          pongIdx: record.pongs.length,
          respondThroughPingIdx: latest.pingIdx,
          content: { text: reply.text, richContent: null, attachments: [] },
          resultLocations: reply.resultLocations ?? [],
          authorAgentId: "agent:scripted",
          submissionId: `sub-${documentId}-${threadId}-${record.pongs.length}`,
          createdAt: store.nextStamp(),
        };
        record.pongs.push(pong);
      }
      return work.length;
    },
  };
}
