/**
 * 文档页跟随 Operator 的异步工作（R17）。两种等待：
 *
 *   1. 文档还没有版本（刚建出来）：每 1.5 秒重拉文档，直到 currentVersionIdx 出现；
 *   2. 刚发出一条评论（新 thread 或追加）：每 1.5 秒重拉那个 thread，直到出现一条
 *      respondThroughCommentIdx ≥ 这条评论 commentIdx 的 reply——水位是累计的，
 *      更早的 reply 不算回复到了这一条。
 *
 * 等到了就调 onProgress（页面用它 reload 整个 session）。reply 与它带出的新版本属于
 * 同一个原子 submission，所以看到 reply 时再 reload，文档的新版本一定一起读得到。
 *
 * 最长等 60 秒，超时给「Operator 暂未响应，可稍后刷新」。单次读取失败不结束等待——
 * 网络抖一下不代表 Operator 没在干活，下一轮再读；真读不到就落到超时提示。
 * 组件卸载或切到别的文档时取消全部轮询，之后不再发任何读取。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadDetail } from "@unidocs/protocol-tenant-portal";
import { useClient } from "../client-context.js";
import {
  isAbortError, OPERATOR_POLL_INTERVAL_MS, OPERATOR_POLL_TIMEOUT_MS, PollTimeoutError, pollUntil,
} from "./poll.js";

export const OPERATOR_SILENT_TEXT = "Operator 暂未响应，可稍后刷新";

export function replyCovers(detail: ThreadDetail | null, commentIdx: number): boolean {
  return detail !== null && detail.replies.some((reply) => reply.respondThroughCommentIdx >= commentIdx);
}

export interface OperatorFollow {
  /** 还有发出的评论在等 reply。 */
  readonly waitingForReply: boolean;
  /** 等待超时的提示；没有则为 null。 */
  readonly notice: string | null;
  followReply(threadId: string, commentIdx: number): void;
}

/** 读失败当作「这一轮还没等到」，让 pollUntil 按间隔继续。 */
function tolerant<T>(read: () => Promise<T>): () => Promise<T | null> {
  return () => read().catch(() => null);
}

export function useOperatorFollow(input: {
  readonly documentId: string;
  readonly awaitingFirstVersion: boolean;
  onProgress(): void;
}): OperatorFollow {
  const client = useClient();
  const { documentId, awaitingFirstVersion } = input;
  const [notice, setNotice] = useState<string | null>(null);
  const [waitingThreads, setWaitingThreads] = useState(0);

  // onProgress 每次渲染都可能是新函数；轮询闭包只在触发时读最新的那个。
  const onProgress = useRef(input.onProgress);
  onProgress.current = input.onProgress;

  const replyFollows = useRef(new Map<string, AbortController>());

  const settle = useCallback((controller: AbortController, cause: unknown) => {
    if (controller.signal.aborted || isAbortError(cause)) return;
    if (cause instanceof PollTimeoutError) setNotice(OPERATOR_SILENT_TEXT);
  }, []);

  useEffect(() => {
    if (!awaitingFirstVersion) return;
    const controller = new AbortController();
    setNotice(null);
    pollUntil(
      tolerant(() => client.getDocument(documentId)),
      (document) => document !== null && document.currentVersionIdx !== null,
      { intervalMs: OPERATOR_POLL_INTERVAL_MS, timeoutMs: OPERATOR_POLL_TIMEOUT_MS, signal: controller.signal },
    )
      .then(() => { if (!controller.signal.aborted) onProgress.current(); })
      .catch((cause: unknown) => settle(controller, cause));
    return () => controller.abort();
  }, [client, documentId, awaitingFirstVersion, settle]);

  // 切换文档或卸载：上一篇文档的 reply 等待全部作废。
  useEffect(() => {
    const follows = replyFollows.current;
    return () => {
      for (const controller of follows.values()) controller.abort();
      follows.clear();
      setWaitingThreads(0);
      setNotice(null);
    };
  }, [client, documentId]);

  const followReply = useCallback((threadId: string, commentIdx: number) => {
    const follows = replyFollows.current;
    // 同一个 thread 上更新的一条评论覆盖旧的等待：盖住新评论的 reply 必然也盖住旧的。
    follows.get(threadId)?.abort();
    const controller = new AbortController();
    follows.set(threadId, controller);
    setWaitingThreads(follows.size);
    setNotice(null);

    pollUntil(
      tolerant(() => client.getThread(documentId, threadId)),
      (detail) => replyCovers(detail, commentIdx),
      { intervalMs: OPERATOR_POLL_INTERVAL_MS, timeoutMs: OPERATOR_POLL_TIMEOUT_MS, signal: controller.signal },
    )
      .then(() => { if (!controller.signal.aborted) onProgress.current(); })
      .catch((cause: unknown) => settle(controller, cause))
      .finally(() => {
        if (follows.get(threadId) !== controller) return;
        follows.delete(threadId);
        setWaitingThreads(follows.size);
      });
  }, [client, documentId, settle]);

  return { waitingForReply: waitingThreads > 0, notice, followReply };
}
