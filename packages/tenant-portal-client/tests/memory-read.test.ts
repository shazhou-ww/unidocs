import { beforeEach, describe, expect, it } from "vitest";
import { createTenantPortalClient } from "../src/client.js";
import { createMemoryTransport } from "../src/memory/transport.js";
import { createMarkdownTextRange } from "../src/doctypes/markdown.js";
import { PlatformError } from "../src/errors.js";
import type { TenantPortalClient } from "../src/client.js";
import type { MarkdownSnapshot } from "../src/doctypes/markdown.js";

const content = "# 样例\n\n第一段。\n\n第二段。\n";

function seeded() {
  return {
    documents: [
      {
        documentId: "doc-1",
        name: "样例文档",
        documentType: "markdown",
        versions: [{ content }, { content: content + "\n第三段。\n" }],
        threads: [
          {
            threadId: "th-1",
            comments: [{ baseVersionIdx: 0, text: "这里能展开吗", location: createMarkdownTextRange({ documentContractIdx: 0, content, start: 7, end: 11 }) }],
            replies: [],
          },
        ],
      },
      { documentId: "doc-2", name: "空文档", documentType: "markdown", versions: [{ content: "# 空\n" }], threads: [] },
    ],
  };
}

describe("memory transport 读操作", () => {
  let client: TenantPortalClient;

  beforeEach(() => {
    client = createTenantPortalClient({ tenantId: "t1", transport: createMemoryTransport({ seed: seeded() }) });
  });

  it("listDocuments 返回 Page 形状并带上 currentVersionIdx", async () => {
    const page = await client.listDocuments();

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ documentId: "doc-1", name: "样例文档", currentVersionIdx: 1 });
  });

  it("listDocuments 按 documentType 筛选", async () => {
    expect((await client.listDocuments({ documentType: "markdown" })).items).toHaveLength(2);
    expect((await client.listDocuments({ documentType: "psd" })).items).toHaveLength(0);
  });

  it("getVersion 只给元数据与 parentVersionIdx，不再带 snapshot", async () => {
    const version = await client.getVersion("doc-1", 1);

    expect(version.versionIdx).toBe(1);
    expect(version.parentVersionIdx).toBe(0);
    expect(version).not.toHaveProperty("snapshot");
  });

  it("getVersionSnapshot 单独返回该版本的内容", async () => {
    const snapshot = await client.getVersionSnapshot("doc-1", 1) as unknown as MarkdownSnapshot;
    expect(snapshot).toMatchObject({ content: expect.stringContaining("第三段") });

    const first = await client.getVersionSnapshot("doc-1", 0) as unknown as MarkdownSnapshot;
    expect(first.content).toBe(content);
  });

  it("首版的 parentVersionIdx 是 null", async () => {
    expect((await client.getVersion("doc-1", 0)).parentVersionIdx).toBeNull();
  });

  it("getThread 返回完整 comment 与 reply 序列", async () => {
    const thread = await client.getThread("doc-1", "th-1");

    expect(thread.threadId).toBe("th-1");
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({ commentIdx: 0, baseVersionIdx: 0 });
    expect(thread.comments[0].content.text).toBe("这里能展开吗");
    expect(thread.replies).toHaveLength(0);
  });

  it("listThreads 只返回 threadId", async () => {
    const page = await client.listThreads("doc-1");
    expect(page.items).toEqual([{ threadId: "th-1" }]);
  });

  it("不存在的文档返回 not_found", async () => {
    await expect(client.getDocument("nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(client.getDocument("nope")).rejects.toBeInstanceOf(PlatformError);
  });

  it("不存在的版本返回 not_found", async () => {
    await expect(client.getVersion("doc-1", 99)).rejects.toMatchObject({ code: "not_found" });
  });

  it("不存在版本的 snapshot 也返回 not_found", async () => {
    await expect(client.getVersionSnapshot("doc-1", 99)).rejects.toMatchObject({ code: "not_found" });
  });

  it("未知路径返回 not_found 而不是抛异常", async () => {
    const transport = createMemoryTransport({ seed: seeded() });
    const result = await transport({ method: "GET", path: "/api/v1/tenants/t1/nonsense" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.code).toBe("not_found");
  });

  it("每个错误都带非空 requestId", async () => {
    const transport = createMemoryTransport({ seed: seeded() });
    const result = await transport({ method: "GET", path: "/api/v1/tenants/t1/documents/nope" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.requestId).not.toBe("");
  });
});
