import { describe, expect, it } from "vitest";
import { createTenantPortalClient } from "../src/client.js";
import { createMemoryTransport } from "../src/memory/transport.js";
import { rangeOf, sampleSeed } from "../src/memory/seed.js";
import { resolveMarkdownTextRange } from "../src/doctypes/markdown.js";
import type { MarkdownSnapshot } from "../src/doctypes/markdown.js";

function client() {
  return createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: sampleSeed() }) });
}

describe("rangeOf", () => {
  it("按原文查出偏移", () => {
    expect(rangeOf("abc 目标 def", "目标")).toEqual({ start: 4, end: 6 });
  });

  it("查不到时抛错，避免样本数据静默错位", () => {
    expect(() => rangeOf("abc", "不存在")).toThrow(/not found/);
  });
});

describe("sampleSeed", () => {
  it("样本文档有多个版本与多处讨论", async () => {
    const api = client();
    const documents = await api.listDocuments();
    const main = documents.items.find((d) => d.documentId === "doc-sample");

    expect(main).toBeDefined();
    expect(main?.currentVersionIdx).not.toBeNull();
    expect((await api.listThreads("doc-sample")).items.length).toBeGreaterThanOrEqual(6);
  });

  it("覆盖六种情形：待回复 / 已回复产新版 / 基于旧版内容仍在 / 基于旧版已改写 / 纯 reply / 基于 current", async () => {
    const api = client();
    const current = (await api.getDocument("doc-sample")).currentVersionIdx as number;
    const snapshot = await api.getVersionSnapshot("doc-sample", current) as unknown as MarkdownSnapshot;

    const detail = async (id: string) => api.getThread("doc-sample", id);
    const ack = (replies: readonly { respondThroughCommentIdx: number }[]) =>
      replies.reduce((max, r) => Math.max(max, r.respondThroughCommentIdx), -1);

    const open = await detail("th-open");
    expect(open.replies).toHaveLength(0);

    const answered = await detail("th-answered");
    expect(ack(answered.replies)).toBe(answered.comments[answered.comments.length - 1].commentIdx);
    expect(answered.replies[0].resultLocations.length).toBeGreaterThan(0);

    const stale = await detail("th-stale-present");
    expect(stale.comments[0].baseVersionIdx).toBeLessThan(current);
    expect(resolveMarkdownTextRange(stale.comments[0].location!, snapshot.content).located).toBe(true);

    const rewritten = await detail("th-stale-rewritten");
    expect(resolveMarkdownTextRange(rewritten.comments[0].location!, snapshot.content)).toEqual({
      located: false,
      reason: "unresolvable",
    });

    const plain = await detail("th-plain-reply");
    expect(plain.replies[0].resultLocations).toEqual([]);

    const onCurrent = await detail("th-on-current");
    expect(onCurrent.comments[0].baseVersionIdx).toBe(current);
  });

  it("还有一件空文档，供空态使用", async () => {
    const api = client();
    expect((await api.listThreads("doc-empty")).items).toEqual([]);
  });
});
