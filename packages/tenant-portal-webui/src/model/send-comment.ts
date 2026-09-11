/**
 * 把一份草稿发送成 ping。新评论建 thread，追加评论走 appendPing。
 * 两条路径都带草稿自己的 idempotencyKey——重试不会产生第二条。
 */
import type { TenantPortalClient } from "@unidocs/tenant-portal-client";
import type { Draft } from "../drafts/draft-store.js";

export async function sendDraft(
  client: TenantPortalClient,
  documentId: string,
  draft: Draft,
): Promise<void> {
  const content = { text: draft.text, richContent: null, attachments: [] };

  if (draft.threadId === null) {
    await client.createThread(documentId, draft.idempotencyKey, {
      baseVersionIdx: draft.baseVersionIdx,
      content,
      location: draft.location,
    });
    return;
  }

  await client.appendPing(documentId, draft.threadId, draft.idempotencyKey, {
    baseVersionIdx: draft.baseVersionIdx,
    content,
    location: draft.location,
  });
}
