/**
 * 假后端里的 Agent。协议上 Agent 通过原子 submission 工作；这里只模拟用户可见的
 * 结果——comment 写入后产出一条 reply，把水位推到当前最新 comment，可选地产生新版本。
 *
 * 同步驱动：不用定时器，测试调 runPending() 明确推进。
 */
import type { AddressedComment, DocumentLocation, ReplyRecord } from "@unidocs/protocol-tenant-portal";
import type { MemoryStore } from "./store.js";
import { isOpen } from "./store.js";

export interface AgentReply {
  readonly text: string;
  /** 省略则为纯 reply：只回复，不产生新版本。 */
  readonly producesContent?: string;
  /** 相对于新版本的位置；纯 reply 应为空。 */
  readonly resultLocations?: readonly DocumentLocation[];
}

export interface AgentContext {
  readonly documentId: string;
  readonly threadId: string;
  readonly latestCommentIdx: number;
  readonly latestCommentText: string | null;
}

/** 只处理这一个 thread——不传（undefined）时处理全店铺待回复的每一处。 */
export interface RunPendingScope {
  readonly documentId: string;
  readonly threadId: string;
}

export interface ScriptedAgent {
  pendingCount(): number;
  /**
   * 处理待回复的一处或多处，返回处理了几处。
   * 传 scope 时只处理那一个 thread（不在其中或已经不是待回复状态则什么都不做）；
   * 不传时处理全店铺待回复的每一处——供测试直接驱动用，行为和之前一样。
   */
  runPending(scope?: RunPendingScope): number;
}

const defaultRespond = (context: AgentContext): AgentReply => ({
  text: `已处理到第 ${context.latestCommentIdx + 1} 条评论。`,
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

    runPending: (scope) => {
      const work = scope === undefined
        ? pending()
        : pending().filter((item) => item.documentId === scope.documentId && item.threadId === scope.threadId);
      for (const { documentId, threadId } of work) {
        const state = store.requireDocument(documentId);
        const record = state.threads.get(threadId);
        if (record === undefined) continue;

        const latest = record.comments[record.comments.length - 1];
        const reply = respond({
          documentId,
          threadId,
          latestCommentIdx: latest.commentIdx,
          latestCommentText: latest.content.text,
        });

        // 同一个 submission 原子地产出这条 reply，以及（如果有）它带出的新版本。
        const submissionId = `sub-${documentId}-${threadId}-${record.replies.length}`;

        if (reply.producesContent !== undefined) {
          // provenance：这条新版本回应了自上一条 reply 的水位以来、到这条最新 comment
          // 为止的每一条 comment。
          const previousAcked = record.replies.reduce(
            (max, r) => Math.max(max, r.respondThroughCommentIdx),
            -1,
          );
          const addressedComments: AddressedComment[] = record.comments
            .filter((comment) => comment.commentIdx > previousAcked && comment.commentIdx <= latest.commentIdx)
            .map((comment) => ({
              threadId,
              commentIdx: comment.commentIdx,
              baseVersionIdx: comment.baseVersionIdx,
            }));
          store.appendVersion(state, reply.producesContent, "agent:scripted", { submissionId, addressedComments });
        }

        const replyRecord: ReplyRecord = {
          replyIdx: record.replies.length,
          respondThroughCommentIdx: latest.commentIdx,
          content: { text: reply.text, richContent: null, attachments: [] },
          resultLocations: reply.resultLocations ?? [],
          authorAgentId: "agent:scripted",
          submissionId,
          createdAt: store.nextStamp(),
        };
        record.replies.push(replyRecord);
      }
      return work.length;
    },
  };
}
