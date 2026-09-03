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
});

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}
