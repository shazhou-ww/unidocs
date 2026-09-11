/**
 * thread 的 open 状态是水位关系的结果，不是标志位——所以界面上没有解决/重新打开按钮。
 * 对应 tenant-webui-v0.md §2.1：open := latestCommentSequence > acknowledgedCommentSequence
 */
import type { ReplyRecord, ThreadDetail } from "@unidocs/protocol-tenant-portal";

export interface ThreadState {
  readonly open: boolean;
  readonly latestCommentIdx: number;
  readonly acknowledgedCommentIdx: number;
  readonly latestReply: ReplyRecord | null;
  /** 纯 reply：只回复、没产生新版本。界面上用中性色，不显示版本号。 */
  readonly latestReplyIsPlain: boolean;
}

export function deriveThreadState(detail: ThreadDetail): ThreadState {
  const acknowledgedCommentIdx = detail.replies.reduce((max, reply) => Math.max(max, reply.respondThroughCommentIdx), -1);
  const latestCommentIdx = detail.comments.reduce((max, comment) => Math.max(max, comment.commentIdx), -1);
  const latestReply = detail.replies.length === 0 ? null : detail.replies[detail.replies.length - 1];

  return {
    open: latestCommentIdx > acknowledgedCommentIdx,
    latestCommentIdx,
    acknowledgedCommentIdx,
    latestReply,
    latestReplyIsPlain: latestReply !== null && latestReply.resultLocations.length === 0,
  };
}
