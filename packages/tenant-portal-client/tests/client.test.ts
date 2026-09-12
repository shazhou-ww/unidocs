import { describe, expect, it } from "vitest";
import { encodeSValue } from "@unidocs/svalue-codec";
import { createTenantPortalClient } from "../src/client.js";
import { PlatformError } from "../src/errors.js";
import type { PlatformRequest, PlatformTransport } from "../src/transport.js";

function recordingTransport(data: unknown = {}) {
  const calls: PlatformRequest[] = [];
  const transport: PlatformTransport = async (request) => {
    calls.push(request);
    return { ok: true, data };
  };
  return { calls, transport };
}

describe("createTenantPortalClient", () => {
  it("listDocuments 拼出带 tenantId 的路径并透传筛选", async () => {
    const { calls, transport } = recordingTransport({ items: [], nextCursor: null });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.listDocuments({ documentType: "markdown", limit: 20 });

    expect(calls[0]).toEqual({
      method: "GET",
      path: "/api/v1/tenants/t1/documents",
      query: { documentType: "markdown", limit: 20, cursor: undefined },
    });
  });

  it("getThread 对路径段做 URL 编码", async () => {
    const { calls, transport } = recordingTransport({ threadId: "a/b", comments: [], replies: [] });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.getThread("doc 1", "a/b");

    expect(calls[0].path).toBe("/api/v1/tenants/t1/documents/doc%201/threads/a%2Fb");
  });

  it("createThread 带上 idempotencyKey", async () => {
    const { calls, transport } = recordingTransport({ threadId: "th-1", comments: [], replies: [] });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.createThread("doc-1", "key-1", {
      baseVersionIdx: 0,
      content: { text: "hi", richContent: null, attachments: [] },
      location: null,
    });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/api/v1/tenants/t1/documents/doc-1/threads");
    expect(calls[0].idempotencyKey).toBe("key-1");
  });

  it("appendComment 落在 thread 路径下", async () => {
    const { calls, transport } = recordingTransport({});
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.appendComment("doc-1", "th-1", "key-2", {
      baseVersionIdx: 1,
      content: { text: "more", richContent: null, attachments: [] },
      location: null,
    });

    expect(calls[0].path).toBe("/api/v1/tenants/t1/documents/doc-1/threads/th-1/comments");
    expect(calls[0].idempotencyKey).toBe("key-2");
  });

  it("getDocumentContract 落在 document-contracts 路径下", async () => {
    const { calls, transport } = recordingTransport({});
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.getDocumentContract("markdown", 0);

    expect(calls[0].path).toBe("/api/v1/tenants/t1/document-types/markdown/document-contracts/0");
  });

  it("getVersionSnapshot 请求独立的 snapshot 路径，要求字节响应并解码 CBOR", async () => {
    const calls: PlatformRequest[] = [];
    const transport: PlatformTransport = async (request) => {
      calls.push(request);
      return { ok: true, bytes: encodeSValue({ content: "# 标题\n" }) };
    };
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    const snapshot = await client.getVersionSnapshot("doc-1", 2);

    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/tenants/t1/documents/doc-1/versions/2/snapshot",
      accept: "cbor",
    });
    expect(snapshot).toEqual({ content: "# 标题\n" });
  });

  it("transport 返回 TenantApiError 时抛 PlatformError", async () => {
    const transport: PlatformTransport = async () => ({
      ok: false,
      error: { error: { code: "not_found", message: "gone", requestId: "req-9" } },
    });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await expect(client.getDocument("doc-1")).rejects.toThrow(PlatformError);
    await expect(client.getDocument("doc-1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("transport 对 getVersionSnapshot 返回 TenantApiError 时也抛 PlatformError", async () => {
    const transport: PlatformTransport = async () => ({
      ok: false,
      error: { error: { code: "content_unavailable", message: "gone", requestId: "req-10" } },
    });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await expect(client.getVersionSnapshot("doc-1", 0)).rejects.toMatchObject({ code: "content_unavailable" });
  });

  it("14 个 operation 都可调用", async () => {
    const { transport } = recordingTransport({ items: [], nextCursor: null });
    const client = createTenantPortalClient({ tenantId: "t1", transport });
    const names = [
      "listPublicDocumentTypes", "getDocumentContract", "listDocuments", "createDocument",
      "getDocument", "listVersions", "getVersion", "getVersionSnapshot", "moveCurrentVersion",
      "listThreads", "createThread", "getThread", "appendComment", "issueCasCapability",
    ] as const;

    for (const name of names) expect(typeof client[name]).toBe("function");
    expect(names).toHaveLength(14);
  });
});
