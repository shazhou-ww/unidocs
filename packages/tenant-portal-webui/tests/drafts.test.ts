import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createDraftStore, anchorKeyOf, type Draft } from "../src/drafts/draft-store.js";
import { useDrafts } from "../src/drafts/use-drafts.js";

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
    const store = createDraftStore(localStorage);
    store.save(draft());

    expect(store.list()).toEqual([draft()]);
  });

  it("跨实例持久化（模拟刷新）", () => {
    createDraftStore(localStorage).save(draft());

    expect(createDraftStore(localStorage).list()).toHaveLength(1);
  });

  it("同一锚点可以并存多份", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ draftId: "d1", text: "第一份" }));
    store.save(draft({ draftId: "d2", idempotencyKey: "key-2", text: "第二份" }));

    expect(store.listForDocument("doc-1")).toHaveLength(2);
    expect(store.countForDocument("doc-1")).toBe(2);
  });

  it("同 draftId 覆盖而不是追加", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ text: "一稿" }));
    store.save(draft({ text: "二稿" }));

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].text).toBe("二稿");
  });

  it("覆盖时保留原 idempotencyKey", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ idempotencyKey: "key-1" }));
    store.save({ ...draft({ text: "改了" }), idempotencyKey: "key-2" });

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].text).toBe("改了");
    expect(store.list()[0].idempotencyKey).toBe("key-1");
  });

  it("remove 只删指定一份", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ draftId: "d1" }));
    store.save(draft({ draftId: "d2", idempotencyKey: "key-2" }));

    store.remove("d1");

    expect(store.list().map((item) => item.draftId)).toEqual(["d2"]);
  });

  it("按文档隔离", () => {
    const store = createDraftStore(localStorage);
    store.save(draft({ draftId: "d1", documentId: "doc-1" }));
    store.save(draft({ draftId: "d2", documentId: "doc-2", idempotencyKey: "key-2" }));

    expect(store.listForDocument("doc-1")).toHaveLength(1);
  });

  it("存储里是坏数据时当作空，不抛错", () => {
    localStorage.setItem("unidocs.portal.drafts.v1", "{ 不是 JSON");

    expect(createDraftStore(localStorage).list()).toEqual([]);
  });

  it("storage 抛异常（无痕模式）时退化为内存，不影响写入", () => {
    const throwing = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    } as unknown as Storage;
    const store = createDraftStore(throwing);

    store.save(draft());

    expect(store.list()).toHaveLength(1);
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
    const { result } = renderHook(() => useDrafts("doc-1"));

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
