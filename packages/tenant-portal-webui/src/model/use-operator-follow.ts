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
 *
 * 发评论是异步的：POST 还在路上时用户可能已经离开或切到另一篇（DocumentPage 不按
 * documentId 重新挂载）。所以 reply 等待绑在「文档作用域」上——每个 [client, documentId]
 * 一个 AbortController，effect 清理时 abort。调用方在发出请求**之前**用 bindReplyFollow()
 * 取得绑定当时作用域的跟随函数，请求回来再调用；那时作用域已经 abort 就直接返回，
 * 不会替已经卸载的页面、或替另一篇文档，开始一轮没人取消的轮询。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadDetail } from "@unidocs/protocol-tenant-portal";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
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
  /**
   * 绑定此刻的文档作用域，返回「开始等这条评论的 reply」的函数。必须在发请求之前同步调用，
   * 请求成功后再调用返回值；作用域已结束（卸载或换了文档）时返回值什么都不做。
   */
  bindReplyFollow(): (threadId: string, commentIdx: number) => void;
}

/** 一篇文档的一次停留：切换文档或卸载时整体 abort，其下每个 reply 等待随之 abort。 */
interface DocumentScope {
  readonly client: TenantPortalClient;
  readonly documentId: string;
  readonly controller: AbortController;
  readonly follows: Map<string, AbortController>;
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

  const scope = useRef<DocumentScope | null>(null);

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

  // 文档作用域：切换文档或卸载时 abort，上一篇文档的 reply 等待（包括还没开始的）全部作废。
  useEffect(() => {
    const current: DocumentScope = { client, documentId, controller: new AbortController(), follows: new Map() };
    scope.current = current;
    return () => {
      current.controller.abort();
      if (scope.current === current) scope.current = null;
      setWaitingThreads(0);
      setNotice(null);
    };
  }, [client, documentId]);

  const followReplyIn = useCallback((bound: DocumentScope, threadId: string, commentIdx: number) => {
    // 请求回来时作用域已经结束：页面卸载了或换了文档，这一轮没人会取消，也没人要看。
    if (bound.controller.signal.aborted) return;

    const { follows } = bound;
    // 同一个 thread 上更新的一条评论覆盖旧的等待：盖住新评论的 reply 必然也盖住旧的。
    follows.get(threadId)?.abort();
    const controller = new AbortController();
    const abortWithScope = () => controller.abort();
    bound.controller.signal.addEventListener("abort", abortWithScope, { once: true });
    follows.set(threadId, controller);
    setWaitingThreads(follows.size);
    setNotice(null);

    pollUntil(
      tolerant(() => bound.client.getThread(bound.documentId, threadId)),
      (detail) => replyCovers(detail, commentIdx),
      { intervalMs: OPERATOR_POLL_INTERVAL_MS, timeoutMs: OPERATOR_POLL_TIMEOUT_MS, signal: controller.signal },
    )
      .then(() => { if (!controller.signal.aborted) onProgress.current(); })
      .catch((cause: unknown) => settle(controller, cause))
      .finally(() => {
        bound.controller.signal.removeEventListener("abort", abortWithScope);
        if (follows.get(threadId) !== controller) return;
        follows.delete(threadId);
        if (!bound.controller.signal.aborted) setWaitingThreads(follows.size);
      });
  }, [settle]);

  const bindReplyFollow = useCallback(() => {
    const bound = scope.current;
    if (bound === null) return () => {};
    return (threadId: string, commentIdx: number) => followReplyIn(bound, threadId, commentIdx);
  }, [followReplyIn]);

  return { waitingForReply: waitingThreads > 0, notice, bindReplyFollow };
}
