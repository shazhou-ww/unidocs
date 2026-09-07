import { beforeEach, describe, expect, it } from "vitest";
import {
  concatenateNodeBytes,
  computeNodeDigest,
  encodeHeader,
  hashToHex,
  hexToHash,
} from "@unicas/codec";
import {
  CasClientError,
  createTenantCasClient,
} from "../src/index.js";
import type { TenantCasClient } from "../src/index.js";
import { MockCasService } from "./mock-cas-service.js";

const STACK = "stack-1";
const TENANT = "tenant-1";

describe("functional tenant CAS client", () => {
  let service: MockCasService;
  let tokenCounter: number;

  beforeEach(() => {
    service = new MockCasService();
    tokenCounter = 0;
  });

  function createClient(uploadMode: "legacy" | "direct" = "legacy") {
    return createTenantCasClient({
      baseUrl: "https://cas.test/",
      stackId: STACK,
      tenantId: TENANT,
      getToken: async () => `token-${++tokenCounter}`,
      fetcher: service,
      uploadMode,
    });
  }

  async function storeNode(
    client: TenantCasClient,
    content: Uint8Array,
    contentType: string,
    refs: readonly string[] = [],
  ): Promise<string> {
    const childHashes = refs.map(hexToHash);
    const header = encodeHeader(content.length, contentType, childHashes.length);
    const hash = hashToHex(await computeNodeDigest(header, contentType, childHashes, content));
    const bytes = concatenateNodeBytes(header, new TextEncoder().encode(contentType), childHashes, content);
    await client.leaseNode(hash, {
      contentLength: bytes.length,
      body: streamBytes(bytes),
    });
    return hash;
  }

  it("creates lazy node readers with metadata and random content access", async () => {
    const client = createClient();
    const content = new TextEncoder().encode("0123456789");
    const hash = await storeNode(client, content, "text/plain");

    expect(service.tokens).toHaveLength(1);
    await expect(client.readMetadata(hash)).resolves.toMatchObject({ hash, size: 10, contentType: "text/plain", refs: [] });
    await expect(new Response(await client.readContent(hash, { offset: 3, length: 4 })).text()).resolves.toBe("3456");
    expect(service.tokens).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
  });

  it("uses one lease operation for content upload and existing nodes", async () => {
    const client = createClient();
    const hash = await storeNode(client, Uint8Array.from([1, 2, 3]), "application/octet-stream");

    await expect(client.leaseNode(hash)).resolves.toMatchObject({ hash, ready: true });
    await expect(client.leaseNode("f".repeat(64))).rejects.toMatchObject({
      status: 404,
      name: "CasClientError",
    });
  });

  it("prepares, uploads, and finalizes canonical nodes in direct mode", async () => {
    const client = createClient("direct");
    const hash = await storeNode(client, Uint8Array.from([1, 2, 3]), "application/octet-stream");

    expect(service.nodes.has(hash)).toBe(true);
    expect(service.directUploads.size).toBe(1);
    expect(service.tokens).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("updates roots and exposes tenant administration operations", async () => {
    const client = createClient();
    const hash = await storeNode(client, Uint8Array.from([1]), "application/octet-stream");

    await expect(client.updateRootRefs({ requestId: "r1", changes: { [hash]: 1 } }))
      .resolves.toMatchObject({ success: true, revision: 1 });
    await expect(client.usage()).resolves.toMatchObject({ nodeCount: 1, leasedNodeCount: 1 });
    await expect(client.gc({ maxNodes: 25 })).resolves.toMatchObject({ examined: 1, deleted: 0 });
    expect(service.rootRefUpdates).toEqual([{ requestId: "r1", changes: { [hash]: 1 } }]);
    expect(service.gcCalls).toEqual([{ maxNodes: 25 }]);
  });

  it("preserves HTTP status on client errors", async () => {
    const error = await createClient().readMetadata("0".repeat(64)).catch(value => value);
    expect(error).toBeInstanceOf(CasClientError);
    expect(error).toMatchObject({ status: 404 });
  });

  it("consumes error response bodies instead of retaining an unread clone", async () => {
    let errorResponse: Response | undefined;
    const client = createTenantCasClient({
      baseUrl: "https://cas.test/",
      stackId: STACK,
      tenantId: TENANT,
      getToken: async () => "token",
      fetcher: {
        async fetch() {
          errorResponse = Response.json({ error: "missing" }, { status: 404 });
          return errorResponse;
        },
      },
    });

    await expect(client.leaseNode("0".repeat(64))).rejects.toMatchObject({ status: 404 });
    expect(errorResponse?.bodyUsed).toBe(true);
  });

  /**
   * 回归：带 buffer body 的 lease 必须**显式**带上 Content-Length。
   *
   * 服务端(unicas-packages/service/src/node-lease.ts)在 declaredLength 缺席时回
   * 411,而它是从 Content-Length 头读的。客户端原先只在 body 是 ReadableStream 时
   * 显式设这个头,buffer body 靠 fetch 自动补 —— 而那份自动值**活不过一次 Request
   * 重建**:Azure 的 doc service 为了埋观测,用 `new Request(input, init)` 加
   * `fetch(target, req)` 包了一层(azure-sdk/src/doc-type-service.ts 的
   * httpCasFetcher),重建之后 body 变成流、长度丢失、转成 chunked,服务端再也看不
   * 到长度,于是 411 Length Required。
   *
   * 实测(Node 24 / undici):直接 fetch 带 ArrayBuffer -> content-length: 64;
   * 经 new Request 包一层 -> content-length 消失、transfer-encoding: chunked;
   * 显式设过的能活下来。所以长度必须由知道它的这一层写死,不能依赖传输层推断。
   *
   * 本文件其余用例都走 streamBytes(),流式路径本来就显式设长度 —— buffer 路径
   * 因此一直没被覆盖到。
   */
  it("buffer body 的 lease 显式带 Content-Length —— 中间任何一次 Request 重建都不该弄丢它", async () => {
    const seen: Array<string | null> = [];
    const client = createTenantCasClient({
      baseUrl: "https://cas.test/",
      stackId: STACK,
      tenantId: TENANT,
      getToken: async () => `token-${++tokenCounter}`,
      // 模拟 httpCasFetcher:重建一次 Request 再转发。长度若只靠传输层自动推断,
      // 这一步就会把它抹掉。
      fetcher: {
        fetch: async (input, init) => {
          const req = new Request(input, init);
          if (req.method === "POST" && new URL(req.url).pathname.endsWith("/lease")) {
            seen.push(req.headers.get("Content-Length"));
          }
          return service.fetch(req);
        },
      },
      uploadMode: "legacy",
    });

    const content = new Uint8Array(128).fill(7);
    const contentType = "application/octet-stream";
    const header = encodeHeader(content.length, contentType, 0);
    const hash = hashToHex(await computeNodeDigest(header, contentType, [], content));
    const bytes = concatenateNodeBytes(header, new TextEncoder().encode(contentType), [], content);

    await client.leaseNode(hash, { contentLength: bytes.length, body: bytes.slice().buffer });

    expect(seen).toEqual([String(bytes.length)]);
  });

});

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}
