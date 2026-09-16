import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createTenantPortalClient, createMemoryTransport, sampleSeed } from "@unidocs/tenant-portal-client";
import { createDraftStore, draftStorageKey, anchorKeyOf, type Draft } from "../src/drafts/draft-store.js";
import { useDrafts } from "../src/drafts/use-drafts.js";
import { ClientProvider } from "../src/client-context.js";
import { TEST_DRAFT_SCOPE } from "./draft-scope.js";

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    draftId: "d1", documentId: "doc-1", anchorKey: "th-1", threadId: "th-1",
    location: null, baseVersionIdx: 0, text: "写了一半",
    idempotencyKey: "key-1", editedFromCommentIdx: null, updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createDraftStore", () => {
  beforeEach(() => localStorage.clear());

  it("保存后能读回来", () => {
    const store = createDraftStore(localStorage, TEST_DRAFT_SCOPE);
    store.save(draft());

    expect(store.list()).toEqual([draft()]);
  });

  it("跨实例持久化（模拟刷新）", () => {
    createDraftStore(localStorage, TEST_DRAFT_SCOPE).save(draft());

    expect(createDraftStore(localStorage, TEST_DRAFT_SCOPE).list()).toHaveLength(1);
  });

  it("同一锚点可以并存多份", () => {
    const store = createDraftStore(localStorage, TEST_DRAFT_SCOPE);
    store.save(draft({ draftId: "d1", text: "第一份" }));
    store.save(draft({ draftId: "d2", idempotencyKey: "key-2", text: "第二份" }));

    expect(store.listForDocument("doc-1")).toHaveLength(2);
    expect(store.countForDocument("doc-1")).toBe(2);
  });

  it("同 draftId 覆盖而不是追加", () => {
    const store = createDraftStore(localStorage, TEST_DRAFT_SCOPE);
    store.save(draft({ text: "一稿" }));
    store.save(draft({ text: "二稿" }));

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].text).toBe("二稿");
  });

  it("覆盖时保留原 idempotencyKey", () => {
    const store = createDraftStore(localStorage, TEST_DRAFT_SCOPE);
    store.save(draft({ idempotencyKey: "key-1" }));
    store.save({ ...draft({ text: "改了" }), idempotencyKey: "key-2" });

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].text).toBe("改了");
    expect(store.list()[0].idempotencyKey).toBe("key-1");
  });

  it("remove 只删指定一份", () => {
    const store = createDraftStore(localStorage, TEST_DRAFT_SCOPE);
    store.save(draft({ draftId: "d1" }));
    store.save(draft({ draftId: "d2", idempotencyKey: "key-2" }));

    store.remove("d1");

    expect(store.list().map((item) => item.draftId)).toEqual(["d2"]);
  });

  it("按文档隔离", () => {
    const store = createDraftStore(localStorage, TEST_DRAFT_SCOPE);
    store.save(draft({ draftId: "d1", documentId: "doc-1" }));
    store.save(draft({ draftId: "d2", documentId: "doc-2", idempotencyKey: "key-2" }));

    expect(store.listForDocument("doc-1")).toHaveLength(1);
  });

  it("存储里是坏数据时当作空，不抛错", () => {
    localStorage.setItem(draftStorageKey(TEST_DRAFT_SCOPE), "{ 不是 JSON");

    expect(createDraftStore(localStorage, TEST_DRAFT_SCOPE).list()).toEqual([]);
  });

  it("storage 抛异常（无痕模式）时退化为内存，不影响写入", () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    } as unknown as Storage;
    const store = createDraftStore(throwing, TEST_DRAFT_SCOPE);

    store.save(draft());

    expect(store.list()).toHaveLength(1);
  });

  it("keeps the v1 key when the merged write fails partway (quota exceeded), so nothing is lost", () => {
    const legacyKey = "unidocs.portal.drafts.v1";
    const backing = new Map<string, string>([[legacyKey, JSON.stringify([draft({ draftId: "legacy" })])]]);
    const partial = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: (key: string) => { backing.delete(key); },
    } as unknown as Storage;

    const store = createDraftStore(partial, TEST_DRAFT_SCOPE);

    expect(store.list().map(item => item.draftId)).toEqual(["legacy"]);
    expect(backing.get(legacyKey)).toBeDefined();
  });

  it("keeps each identity's drafts apart on a shared browser", () => {
    createDraftStore(localStorage, { tenantId: "t1", principalId: "user:a" }).save(draft({ text: "A 的草稿" }));
    expect(createDraftStore(localStorage, { tenantId: "t1", principalId: "user:b" }).list()).toEqual([]);
    expect(createDraftStore(localStorage, { tenantId: "t2", principalId: "user:a" }).list()).toEqual([]);
    expect(createDraftStore(localStorage, { tenantId: "t1", principalId: "user:a" }).list()).toHaveLength(1);
  });

  it("moves legacy unscoped drafts to the first identity that loads, once", () => {
    localStorage.setItem("unidocs.portal.drafts.v1", JSON.stringify([draft({ draftId: "legacy" })]));
    const first = createDraftStore(localStorage, { tenantId: "t1", principalId: "user:a" });
    expect(first.list().map(item => item.draftId)).toEqual(["legacy"]);
    expect(localStorage.getItem("unidocs.portal.drafts.v1")).toBeNull();
    expect(createDraftStore(localStorage, { tenantId: "t1", principalId: "user:b" }).list()).toEqual([]);
  });

  it("merges legacy drafts into existing scoped drafts without duplicating ids", () => {
    const scope = { tenantId: "t1", principalId: "user:a" };
    createDraftStore(localStorage, scope).save(draft({ draftId: "kept" }));
    localStorage.setItem("unidocs.portal.drafts.v1", JSON.stringify([draft({ draftId: "kept", text: "old" }), draft({ draftId: "legacy" })]));
    expect(createDraftStore(localStorage, scope).list().map(item => item.draftId).sort()).toEqual(["kept", "legacy"]);
  });
});

describe("anchorKeyOf", () => {
  it("已有 thread 用 threadId", () => {
    expect(anchorKeyOf({ threadId: "th-1", location: null })).toBe("thread:th-1");
  });

  it("新评论用 location 的稳定摘要", () => {
    const location = { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 3, end: 9, quote: "一段话" } };

    expect(anchorKeyOf({ threadId: null, location })).toBe(anchorKeyOf({ threadId: null, location: { ...location } }));
  });

  it("不同位置得到不同 key", () => {
    const a = { documentContractIdx: 0, locationType: "t", payload: { start: 0, end: 1, quote: "a" } };
    const b = { documentContractIdx: 0, locationType: "t", payload: { start: 5, end: 6, quote: "b" } };

    expect(anchorKeyOf({ threadId: null, location: a })).not.toBe(anchorKeyOf({ threadId: null, location: b }));
  });
});

describe("useDrafts", () => {
  beforeEach(() => localStorage.clear());

  it("saveDraft 覆盖同一 draftId 时返回值里的 idempotencyKey 不变，text 是新的", () => {
    const client = createTenantPortalClient({ tenantId: "t-test", transport: createMemoryTransport({ seed: sampleSeed() }) });
    const { result } = renderHook(() => useDrafts("doc-1"), {
      wrapper: ({ children }) => <ClientProvider client={client} draftScope={TEST_DRAFT_SCOPE}>{children}</ClientProvider>,
    });

    let first!: Draft;
    act(() => {
      first = result.current.saveDraft({ threadId: "th-1", location: null, baseVersionIdx: 0, text: "一稿" });
    });

    let second!: Draft;
    act(() => {
      second = result.current.saveDraft({
        draftId: first.draftId, threadId: "th-1", location: null, baseVersionIdx: 0, text: "二稿",
      });
    });

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.text).toBe("二稿");
  });
});
