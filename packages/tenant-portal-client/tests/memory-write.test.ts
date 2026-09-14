import { beforeEach, describe, expect, it } from "vitest";
import { createTenantPortalClient } from "../src/client.js";
import type { TenantPortalClient } from "../src/client.js";
import { createMemoryStore } from "../src/memory/store.js";
import { sampleSeed } from "../src/memory/seed.js";
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

  it("createThread 建出带第一条 comment 的 thread", async () => {
    const thread = await client.createThread("doc-1", "key-1", {
      baseVersionIdx: 1,
      content: text("第一条"),
      location: null,
    });

    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({ commentIdx: 0, baseVersionIdx: 1 });
    expect(thread.replies).toHaveLength(0);
    expect(store.listThreadIds("doc-1")).toEqual([thread.threadId]);
  });

  it("appendComment 递增 commentIdx", async () => {
    const thread = await client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("一"), location: null });
    const comment = await client.appendComment("doc-1", thread.threadId, "key-2", {
      baseVersionIdx: 1,
      content: text("二"),
      location: null,
    });

    expect(comment.commentIdx).toBe(1);
    expect((await client.getThread("doc-1", thread.threadId)).comments).toHaveLength(2);
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

  it("appendComment 的幂等与 createThread 不串号", async () => {
    const thread = await client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("一"), location: null });
    const body = { baseVersionIdx: 1, content: text("二"), location: null };

    const first = await client.appendComment("doc-1", thread.threadId, "key-2", body);
    const second = await client.appendComment("doc-1", thread.threadId, "key-2", body);

    expect(second.commentIdx).toBe(first.commentIdx);
    expect((await client.getThread("doc-1", thread.threadId)).comments).toHaveLength(2);
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
    const record = await client.createDocument("key-doc-1", { documentType: "markdown", name: "新作品" });

    expect(record.currentVersionIdx).toBeNull();
    expect(record.name).toBe("新作品");
  });

  // Finding 2（终审）：契约要求 createDocument 带 idempotency-key，内存 transport 之前
  // 对缺 key 的请求视而不见——client 换了签名后这里补上 client 侧的转发断言。
  it("createDocument 把 idempotencyKey 转发成 idempotency-key 请求头", async () => {
    const first = await client.createDocument("key-doc-dup", { documentType: "markdown", name: "重放" });
    const second = await client.createDocument("key-doc-dup", { documentType: "markdown", name: "重放" });

    expect(second.documentId).toBe(first.documentId);
  });

  // Finding 2（终审）：真实服务端的 IdempotentMutationHeadersSchema 会在 oRPC 校验阶段
  // 就拒绝没带 idempotency-key 的请求；内存 transport 以前对缺 key 视而不见，是假后端
  // 掩盖真缺陷的又一处（同 global-constraints 提到的 D1 替身教训同构）。这里绕开 client
  // （它现在在类型层面就不让你不传 key），直接给 transport 一个没有 idempotencyKey 的
  // PlatformRequest，断言按真实服务端同样的形状拒绝：400 invalid_request。
  it("createDocument 的 POST 请求缺 idempotency-key 时被拒绝，形状与真实服务端一致", async () => {
    const transport = createMemoryTransport({ store });
    const result = await transport({
      method: "POST",
      path: "/api/v1/tenants/t1/documents",
      body: { documentType: "markdown", name: "无 key" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("invalid_request");
  });

  it("createThread 的 POST 请求缺 idempotency-key 时同样被拒绝", async () => {
    const transport = createMemoryTransport({ store });
    const result = await transport({
      method: "POST",
      path: "/api/v1/tenants/t1/documents/doc-1/threads",
      body: { baseVersionIdx: 1, content: text("一"), location: null },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("invalid_request");
  });

  it("appendComment 的 POST 请求缺 idempotency-key 时同样被拒绝", async () => {
    const thread = await client.createThread("doc-1", "key-1", { baseVersionIdx: 1, content: text("一"), location: null });
    const transport = createMemoryTransport({ store });
    const result = await transport({
      method: "POST",
      path: `/api/v1/tenants/t1/documents/doc-1/threads/${thread.threadId}/comments`,
      body: { baseVersionIdx: 1, content: text("二"), location: null },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("invalid_request");
  });

  it("createThread 生成的 id 与 seed 中已有的 thread id 撞车时不覆盖它", () => {
    const seeded = createMemoryStore({
      documents: [
        {
          documentId: "doc-1",
          name: "样例",
          versions: [{ content: "# 一\n" }],
          threads: [
            {
              threadId: "th-2",
              comments: [{ baseVersionIdx: 0, text: "seeded", location: null }],
              replies: [],
            },
          ],
        },
      ],
    });

    // state.threads.size 是 1，size 派生方案会算出 "th-2"——与 seed 里已有的 thread 撞车。
    const created = seeded.createThread("doc-1", { baseVersionIdx: 0, content: text("new"), location: null });

    expect(seeded.listThreadIds("doc-1")).toHaveLength(2);
    expect(created.threadId).not.toBe("th-2");
    expect(seeded.getThread("doc-1", "th-2").comments[0]?.content.text).toBe("seeded");
    expect(seeded.getThread("doc-1", created.threadId).comments[0]?.content.text).toBe("new");
  });

  it("createDocument 生成的 id 与 seed 中已有的 document id 撞车时不覆盖它", () => {
    const seeded = createMemoryStore({
      documents: [
        {
          documentId: "doc-2-2",
          name: "占位",
          versions: [],
          threads: [],
        },
      ],
    });

    // documents.size 是 1，size 派生方案对 name.length === 2 会算出 "doc-2-2"——与 seed 撞车。
    const created = seeded.createDocument("ab", "markdown");

    expect(seeded.listDocuments()).toHaveLength(2);
    expect(created.documentId).not.toBe("doc-2-2");
    expect(seeded.toRecord(seeded.requireDocument("doc-2-2")).name).toBe("占位");
    expect(seeded.toRecord(seeded.requireDocument(created.documentId)).name).toBe("ab");
  });
});

// 问题 D：agent.autoRun 曾经在任何一次写成功后都跑 runPending()（whole-store），
// 而 runPending() 处理的是「全店铺待回复的每一处」——写一处会把 sampleSeed() 播好种的
// 其它几处开放 thread 一起答掉，收拢成一种状态，seed 数据本来精心铺的六种情形当场
// 塌缩。修复后 autoRun 必须只处理刚写的那一个 thread。
describe("memory transport agent.autoRun 的作用范围", () => {
  it("写一处只让那一处被 Agent 答复，其余种子里已经开放的 thread 原样保留", async () => {
    const store = createMemoryStore(sampleSeed());
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: createMemoryTransport({ store, agent: { autoRun: true } }),
    });

    // th-open / th-stale-present / th-stale-rewritten 在 sampleSeed() 里都是没有 reply
    // 的开放 thread；只往 th-open 追加一条。
    await client.appendComment("doc-sample", "th-open", "key-1", {
      baseVersionIdx: 2,
      content: text("追加一条"),
      location: null,
    });

    expect((await client.getThread("doc-sample", "th-open")).replies).toHaveLength(1);
    expect((await client.getThread("doc-sample", "th-stale-present")).replies).toHaveLength(0);
    expect((await client.getThread("doc-sample", "th-stale-rewritten")).replies).toHaveLength(0);
  });
});
