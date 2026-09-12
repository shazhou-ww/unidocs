/**
 * host.createThread 的真正实现（§3.1 第一个入口：View 读到选区、编码成
 * DocumentLocation 后调这个方法）。
 *
 * 不能直连 client：那样发送失败就直接丢字——这条路径此前唯一一次绕过了草稿
 * 系统，是本模块存在的原因。改成和其它发送路径同样的语义：
 *
 *   1. 按 anchorKeyOf({ threadId: null, location }) 找这个锚点已有的草稿，
 *      有就复用它的 draftId（从而复用它的 idempotencyKey），没有就新建；
 *   2. 用 client.createThread 发送，出错就整个往上抛——草稿原样留在本地，
 *      View 自己展示错误；
 *   3. 成功后移除草稿、通知调用方刷新（比如 session.reload()）。
 *
 * 依赖全部以参数传入，不直接读 React state/hooks，所以能在没有 DOM、没有
 * Selection API 的情况下被直接调用和测试——这正是这条路径原本测不到的部分。
 */
import type { CreateThreadRequest, ThreadDetail } from "@unidocs/protocol-platform";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import { anchorKeyOf, type Draft } from "../drafts/draft-store.js";

export interface CreateThreadFromViewDeps {
  readonly client: TenantPortalClient;
  readonly documentId: string;
  draftsForAnchor(anchorKey: string): readonly Draft[];
  saveDraft(input: {
    draftId?: string;
    threadId: string | null;
    location: Draft["location"];
    baseVersionIdx: number;
    text: string;
  }): Draft;
  removeDraft(draftId: string): void;
  /** 发送成功后的回调——调用方用它触发 session.reload() 之类的刷新。 */
  onSent(): void;
}

export async function createThreadFromView(
  deps: CreateThreadFromViewDeps,
  request: CreateThreadRequest,
): Promise<ThreadDetail> {
  const anchorKey = anchorKeyOf({ threadId: null, location: request.location });
  const existing = deps.draftsForAnchor(anchorKey)[0] ?? null;

  const draft = deps.saveDraft({
    draftId: existing?.draftId,
    threadId: null,
    location: request.location,
    baseVersionIdx: request.baseVersionIdx,
    text: request.content.text ?? "",
  });

  // 复用草稿自己的 idempotencyKey——同一份草稿重试永远带同一个键，即使
  // 期间用户没改一个字也没关系（saveDraft 对同一 draftId 会保留原键）。
  const detail = await deps.client.createThread(deps.documentId, draft.idempotencyKey, {
    baseVersionIdx: draft.baseVersionIdx,
    content: { text: draft.text, richContent: null, attachments: [] },
    location: draft.location,
  });

  deps.removeDraft(draft.draftId);
  deps.onSent();
  return detail;
}
