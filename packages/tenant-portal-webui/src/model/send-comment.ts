/**
 * 把一份草稿发送成评论。新评论建 thread，追加评论走 appendComment。
 * 两条路径都带草稿自己的 idempotencyKey——重试不会产生第二条。
 * 返回落下的这条评论在哪个 thread、第几条，页面据此等 Operator 的 reply（R17）。
 */
import type { ThreadDetail } from "@unidocs/protocol-tenant-portal";
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import type { Draft } from "../drafts/draft-store.js";

export interface SentComment {
  readonly threadId: string;
  readonly commentIdx: number;
}

/** 新建的 thread 里，最后一条就是这次发出的评论。 */
export function sentCommentOf(detail: ThreadDetail): SentComment {
  return { threadId: detail.threadId, commentIdx: detail.comments[detail.comments.length - 1]?.commentIdx ?? 0 };
}

export async function sendDraft(
  client: TenantPortalClient,
  documentId: string,
  draft: Draft,
): Promise<SentComment> {
  const content = { text: draft.text, richContent: null, attachments: [] };

  if (draft.threadId === null) {
    const detail = await client.createThread(documentId, draft.idempotencyKey, {
      baseVersionIdx: draft.baseVersionIdx,
      content,
      location: draft.location,
    });
    return sentCommentOf(detail);
  }

  const comment = await client.appendComment(documentId, draft.threadId, draft.idempotencyKey, {
    baseVersionIdx: draft.baseVersionIdx,
    content,
    location: draft.location,
  });
  return { threadId: draft.threadId, commentIdx: comment.commentIdx };
}
