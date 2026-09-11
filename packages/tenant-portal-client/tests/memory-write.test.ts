import { beforeEach, describe, expect, it } from "vitest";
import { createTenantPortalClient } from "../src/client.js";
import type { TenantPortalClient } from "../src/client.js";
import { createMemoryStore } from "../src/memory/store.js";
import { createMemoryTransport } from "../src/memory/transport.js";
import type { MemoryStore } from "../src/memory/store.js";

const text = (value: string) => ({ text: value, richContent: null, attachments: [] });

function fixture() {
  const store = createMemoryStore({
    documents: [
      {
        documentId: "doc-1",
        name: "样例",
        versions: [{ content: "# 一\n" }, { content: "# 一\n\n二\n" }],
        threads: [],
      },
    ],
  });
  return { store, client: createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ store }) }) };
}

describe("memory transport 写操作", () => {
  let client: TenantPortalClient;
  let store: MemoryStore;

  beforeEach(() => {
    ({ client, store } = fixture());
  });

  it("createThread 建出带第一条 ping 的 thread", async () => {
    const thread = await client.createThread("doc-1", "key-1", {
      baseVersionIdx: 1,
      content: text("第一条"),
      location: null,
    });

    expect(thread.pings).toHaveLength(1);
    expect(thread.pings[0]).toMatchObject({ pingIdx: 0, baseVersionIdx: 1 });
    expect(thread.pongs).toHaveLength(0);
    expect(store.listThreadIds("doc-1")).toEqual([thread.threadId]);
  });

  it("appendPing 递增 pingIdx", async () => {
    const thread = await client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("一"), location: null });
    const ping = await client.appendPing("doc-1", thread.threadId, "key-2", {
      baseVersionIdx: 1,
      content: text("二"),
      location: null,
    });

    expect(ping.pingIdx).toBe(1);
    expect((await client.getThread("doc-1", thread.threadId)).pings).toHaveLength(2);
  });

  it("同 key 同内容重放原结果，不产生第二条", async () => {
    const body = { baseVersionIdx: 1, content: text("一"), location: null };
    const first = await client.createThread("doc-1", "key-1", body);
    const second = await client.createThread("doc-1", "key-1", body);

    expect(second.threadId).toBe(first.threadId);
    expect(store.listThreadIds("doc-1")).toHaveLength(1);
  });

  it("同 key 不同内容返回 idempotency_conflict", async () => {
    await client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("一"), location: null });

    await expect(
      client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("换了"), location: null }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("appendPing 的幂等与 createThread 不串号", async () => {
    const thread = await client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("一"), location: null });
    const body = { baseVersionIdx: 1, content: text("二"), location: null };

    const first = await client.appendPing("doc-1", thread.threadId, "key-2", body);
    const second = await client.appendPing("doc-1", thread.threadId, "key-2", body);

    expect(second.pingIdx).toBe(first.pingIdx);
    expect((await client.getThread("doc-1", thread.threadId)).pings).toHaveLength(2);
  });

  it("baseVersionIdx 指向不存在的版本时 invalid_request", async () => {
    await expect(
      client.createThread("doc-1", "key-1", { baseVersionIdx: 99, content: text("一"), location: null }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("moveCurrentVersion 在观测值匹配时移动指针", async () => {
    const record = await client.moveCurrentVersion("doc-1", {
      observedCurrentVersionIdx: 1,
      targetVersionIdx: 0,
      reason: "回看旧版",
    });

    expect(record.currentVersionIdx).toBe(0);
  });

  it("moveCurrentVersion 在观测值过期时 version_conflict 且不改动指针", async () => {
    await expect(
      client.moveCurrentVersion("doc-1", { observedCurrentVersionIdx: 0, targetVersionIdx: 0, reason: "x" }),
    ).rejects.toMatchObject({ code: "version_conflict" });

    expect((await client.getDocument("doc-1")).currentVersionIdx).toBe(1);
  });

  it("createDocument 建出没有版本的文档，currentVersionIdx 为 null", async () => {
    const record = await client.createDocument({ documentType: "markdown", name: "新作品" });

    expect(record.currentVersionIdx).toBeNull();
    expect(record.name).toBe("新作品");
  });
});
