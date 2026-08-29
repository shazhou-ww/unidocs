import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToHex, sha256 } from "@unicas/codec";
import {
  CasClientError,
  createTenantCasClient,
} from "../src/index.js";
import { createCasBlobClient, storeNodeContent } from "@unicas/tenant-blob-client";
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

  function createClient() {
    return createTenantCasClient({
      baseUrl: "https://cas.test/",
      stackId: STACK,
      tenantId: TENANT,
      getToken: async () => `token-${++tokenCounter}`,
      fetcher: service,
    });
  }

  it("creates lazy node readers with metadata and random content access", async () => {
    const client = createClient();
    const content = new TextEncoder().encode("0123456789");
    const hash = await storeNodeContent(client, content, "text/plain");

    const reader = client.node(hash);
    expect(service.tokens).toHaveLength(1);
    await expect(reader.metadata()).resolves.toMatchObject({ hash, size: 10, contentType: "text/plain", refs: [] });
    await expect(new Response(await reader.read({ offset: 3, length: 4 })).text()).resolves.toBe("3456");
    expect(service.tokens).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
  });

  it("uses one lease operation for content upload and existing nodes", async () => {
    const client = createClient();
    const hash = await storeNodeContent(client, Uint8Array.from([1, 2, 3]), "application/octet-stream");

    await expect(client.leaseNode(hash)).resolves.toMatchObject({ hash, ready: true });
    await expect(client.leaseNode("f".repeat(64))).rejects.toMatchObject({
      status: 404,
      name: "CasClientError",
    });
  });

  it("updates roots and exposes tenant administration operations", async () => {
    const client = createClient();
    const hash = await storeNodeContent(client, Uint8Array.from([1]), "application/octet-stream");

    await expect(client.updateRootRefs({ requestId: "r1", changes: { [hash]: 1 } }))
      .resolves.toMatchObject({ success: true, revision: 1 });
    await expect(client.usage()).resolves.toMatchObject({ nodeCount: 1, leasedNodeCount: 1 });
    await expect(client.gc({ maxNodes: 25 })).resolves.toMatchObject({ examined: 1, deleted: 0 });
    expect(service.rootRefUpdates).toEqual([{ requestId: "r1", changes: { [hash]: 1 } }]);
    expect(service.gcCalls).toEqual([{ maxNodes: 25 }]);
  });

  it("stores and reads deterministic chunk-tree blobs", async () => {
    const cas = createClient();
    const chunkBytes = 4;
    const blobs = createCasBlobClient(cas, { chunkBytes, indexFanout: 2 });
    const bytes = Uint8Array.from([
      0x61, 0x61, 0x61, 0x61,
      0x62, 0x62, 0x62, 0x62,
      0x63, 0x64, 0x65,
    ]);
    const progress = vi.fn();

    const ref = await blobs.storeBlob(streamOf(bytes, 1024 * 1024 + 1), {
      contentType: "application/octet-stream",
      size: bytes.length,
      onProgress: progress,
    });
    const handle = await blobs.openBlob(ref.hash);
    expect(handle.ref).toEqual(ref);
    const opened = new Uint8Array(await new Response(handle.read()).arrayBuffer());
    expect(opened.length).toBe(bytes.length);
    expect(hashToHex(await sha256(opened))).toBe(hashToHex(await sha256(bytes)));
    const ranged = new Uint8Array(await new Response(handle.read({
      offset: chunkBytes - 2,
      length: 4,
    })).arrayBuffer());
    expect(ranged).toEqual(Uint8Array.from([0x61, 0x61, 0x62, 0x62]));
    const bounded = await handle.readBytes({ offset: chunkBytes - 2, length: 4 });
    expect(bounded).toEqual(ranged);
    await expect(blobs.usage()).resolves.toBeDefined();
    await expect(blobs.gc({ maxNodes: 25 })).resolves.toBeDefined();
    expect(progress).toHaveBeenLastCalledWith(bytes.length);
  }, 20_000);

  it("preserves HTTP status on client errors", async () => {
    const error = await createClient().node("0".repeat(64)).metadata().catch(value => value);
    expect(error).toBeInstanceOf(CasClientError);
    expect(error).toMatchObject({ status: 404 });
  });
});

function streamOf(bytes: Uint8Array, fragmentSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + fragmentSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}
