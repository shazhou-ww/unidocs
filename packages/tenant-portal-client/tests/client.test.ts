import { describe, expect, it, vi } from "vitest";
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
    const { calls, transport } = recordingTransport({ threadId: "a/b", pings: [], pongs: [] });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.getThread("doc 1", "a/b");

    expect(calls[0].path).toBe("/api/v1/tenants/t1/documents/doc%201/threads/a%2Fb");
  });

  it("createThread 带上 idempotencyKey", async () => {
    const { calls, transport } = recordingTransport({ threadId: "th-1", pings: [], pongs: [] });
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

  it("appendPing 落在 thread 路径下", async () => {
    const { calls, transport } = recordingTransport({});
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await client.appendPing("doc-1", "th-1", "key-2", {
      baseVersionIdx: 1,
      content: { text: "more", richContent: null, attachments: [] },
      location: null,
    });

    expect(calls[0].path).toBe("/api/v1/tenants/t1/documents/doc-1/threads/th-1/pings");
    expect(calls[0].idempotencyKey).toBe("key-2");
  });

  it("transport 返回 ApiError 时抛 PlatformError", async () => {
    const transport: PlatformTransport = async () => ({
      ok: false,
      error: { error: { code: "not_found", message: "gone", requestId: "req-9" } },
    });
    const client = createTenantPortalClient({ tenantId: "t1", transport });

    await expect(client.getDocument("doc-1")).rejects.toThrow(PlatformError);
    await expect(client.getDocument("doc-1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("13 个 operation 都可调用", async () => {
    const { transport } = recordingTransport({ items: [], nextCursor: null });
    const client = createTenantPortalClient({ tenantId: "t1", transport });
    const names = [
      "listPublicDocumentTypes", "getDocumentContract", "listDocuments", "createDocument",
      "getDocument", "listVersions", "getVersion", "moveCurrentVersion", "listThreads",
      "createThread", "getThread", "appendPing", "issueCasCapability",
    ] as const;

    for (const name of names) expect(typeof client[name]).toBe("function");
    expect(names).toHaveLength(13);
  });
});
