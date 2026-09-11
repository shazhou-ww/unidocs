/**
 * 作品卡片的讨论计数。
 *
 * N+1 集中在这里：listThreads 只返回 ThreadRef（仅 threadId），DocumentRecord 也没有
 * 讨论计数，所以只能逐个 getThread。假后端下没有性能问题。缺口记在
 * docs/design/platform-v0/tenant/TODO.md；协议补上计数后只改本文件。
 */
import type { ThreadDetail } from "@unidocs/protocol-platform";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import { deriveThreadState, type ThreadState } from "./thread-state.js";

export interface SummarizedThread {
  readonly detail: ThreadDetail;
  readonly state: ThreadState;
}

export interface DiscussionSummary {
  readonly openCount: number;
  readonly answeredCount: number;
  readonly threads: readonly SummarizedThread[];
  /** 最近一条 Agent 回复，供工作台顶部的「Agent 最新回复」用。 */
  readonly latestPong: { readonly threadId: string; readonly text: string | null; readonly isPlain: boolean } | null;
}

export async function loadDiscussionSummary(
  client: TenantPortalClient,
  documentId: string,
): Promise<DiscussionSummary> {
  const refs = await client.listThreads(documentId);
  const details = await Promise.all(refs.items.map((ref) => client.getThread(documentId, ref.threadId)));
  const threads = details.map((detail) => ({ detail, state: deriveThreadState(detail) }));

  let latestPong: DiscussionSummary["latestPong"] = null;
  let latestAt = "";
  for (const { detail, state } of threads) {
    if (state.latestPong === null) continue;
    if (state.latestPong.createdAt <= latestAt) continue;
    latestAt = state.latestPong.createdAt;
    latestPong = { threadId: detail.threadId, text: state.latestPong.content.text, isPlain: state.latestPongIsPlain };
  }

  return {
    openCount: threads.filter((thread) => thread.state.open).length,
    answeredCount: threads.filter((thread) => !thread.state.open).length,
    threads,
    latestPong,
  };
}
