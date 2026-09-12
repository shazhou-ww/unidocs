/**
 * 问题 1 的回归测试：选区来的「添加评论」不能绕过草稿系统直连 client——
 * 发送失败必须保留草稿，重试必须复用同一个 idempotencyKey。View 的 Selection
 * 在 jsdom 下测不到，但 createThreadFromView 本身不碰 DOM/Selection，所有
 * 依赖都以参数传入，可以完全脱离 React/DOM 直接调用和断言，这条能真正守住修复。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateThreadRequest, DocumentLocation } from "@unidocs/protocol-tenant-portal";
import { createMemoryStore, createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { anchorKeyOf, createDraftStore, type Draft } from "../src/drafts/draft-store.js";
import { createThreadFromView, type CreateThreadFromViewDeps } from "../src/model/create-thread-from-view.js";

const location: DocumentLocation = {
  documentContractIdx: 0,
  locationType: "unidocs.markdown.text-range/v1",
  payload: { start: 0, end: 3, quote: "abc" },
};

/** 和 use-drafts.ts 里的 saveDraft 实现同样的语义，脱离 React 单独复刻一份，
    好让这个测试不需要渲染任何组件。 */
function fakeDrafts(documentId: string) {
  const store = createDraftStore(localStorage);
  const saveDraft: CreateThreadFromViewDeps["saveDraft"] = (input) => {
    const draftId = input.draftId ?? crypto.randomUUID();
    const draft: Draft = {
      draftId,
      documentId,
      anchorKey: anchorKeyOf({ threadId: input.threadId, location: input.location }),
      threadId: input.threadId,
      location: input.location,
      baseVersionIdx: input.baseVersionIdx,
      text: input.text,
      idempotencyKey: crypto.randomUUID(),
      editedFromCommentIdx: null,
      updatedAt: new Date().toISOString(),
    };
    store.save(draft);
    return store.list().find((candidate) => candidate.draftId === draftId) ?? draft;
  };

  return {
    draftsForAnchor: (anchorKey: string) => store.list().filter((candidate) => candidate.anchorKey === anchorKey),
    saveDraft,
    removeDraft: (draftId: string) => store.remove(draftId),
  };
}

describe("createThreadFromView", () => {
  beforeEach(() => localStorage.clear());

  it("失败时草稿留在原地；重试复用同一个 idempotencyKey，最终只建出一条 thread", async () => {
    const store = createMemoryStore(sampleSeed());
    const keys: string[] = [];
    let failNext = true;
    const inner = createMemoryTransport({ store });
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: async (request) => {
        if (request.idempotencyKey !== undefined) keys.push(request.idempotencyKey);
        if (failNext && request.method === "POST") {
          failNext = false;
          return { ok: false, error: { error: { code: "limit_exceeded", message: "too many", requestId: "r1" } } };
        }
        return inner(request);
      },
    });

    const drafts = fakeDrafts("doc-sample");
    const onSent = vi.fn();
    const anchorKey = anchorKeyOf({ threadId: null, location });
    const request: CreateThreadRequest = {
      baseVersionIdx: 2,
      content: { text: "选区来的评论", richContent: null, attachments: [] },
      location,
    };
    const threadsBefore = store.listThreadIds("doc-sample").length;

    const deps: CreateThreadFromViewDeps = {
      client,
      documentId: "doc-sample",
      draftsForAnchor: drafts.draftsForAnchor,
      saveDraft: drafts.saveDraft,
      removeDraft: drafts.removeDraft,
      onSent,
    };

    // 第一次：失败——草稿必须还在，onSent 不能被调用（不能误以为已发送）。
    await expect(createThreadFromView(deps, request)).rejects.toThrow();

    const pendingAfterFailure = drafts.draftsForAnchor(anchorKey);
    expect(pendingAfterFailure).toHaveLength(1);
    expect(pendingAfterFailure[0].text).toBe("选区来的评论");
    expect(onSent).not.toHaveBeenCalled();
    expect(store.listThreadIds("doc-sample")).toHaveLength(threadsBefore);

    // 重试：同一个 location → anchorKeyOf 命中同一条草稿 → 复用同一个 draftId，
    // 从而复用同一个 idempotencyKey（这一步不传 draftId，createThreadFromView
    // 自己要能找到已有的那份，不是靠调用方记住 draftId）。
    const detail = await createThreadFromView(deps, request);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(onSent).toHaveBeenCalledOnce();
    expect(drafts.draftsForAnchor(anchorKey)).toHaveLength(0);
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0].content.text).toBe("选区来的评论");
    expect(store.listThreadIds("doc-sample")).toHaveLength(threadsBefore + 1);
  });

  it("这个位置已经有一份“写到一半”的草稿时，发送复用它的 idempotencyKey 而不是另起一份", async () => {
    const store = createMemoryStore(sampleSeed());
    const keys: string[] = [];
    const inner = createMemoryTransport({ store });
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: async (request) => {
        if (request.idempotencyKey !== undefined) keys.push(request.idempotencyKey);
        return inner(request);
      },
    });
    const drafts = fakeDrafts("doc-sample");
    const anchorKey = anchorKeyOf({ threadId: null, location });

    // 先手动种一条“写到一半”的草稿（模拟用户上次没发完就切走了）。
    const existing = drafts.saveDraft({ threadId: null, location, baseVersionIdx: 2, text: "半截话" });

    await createThreadFromView({
      client,
      documentId: "doc-sample",
      draftsForAnchor: drafts.draftsForAnchor,
      saveDraft: drafts.saveDraft,
      removeDraft: drafts.removeDraft,
      onSent: () => {},
    }, {
      baseVersionIdx: 2,
      content: { text: "半截话", richContent: null, attachments: [] },
      location,
    });

    // 用的是那份已有草稿自己的 idempotencyKey，不是临时现生成的一个——
    // 证明 createThreadFromView 真的先查了 draftsForAnchor 再决定用哪个 draftId。
    expect(keys).toEqual([existing.idempotencyKey]);
    expect(drafts.draftsForAnchor(anchorKey)).toHaveLength(0);
  });
});
