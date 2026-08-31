/**
 * Functional blob-layer tests: `createCasBlobClient` over an in-memory
 * `TenantCasClient` (no HTTP, no transport). Covers deterministic chunk-tree
 * store, handle-shaped reads (whole / ranged / bounded), retention operations,
 * and access to the underlying tenant client.
 */

import { describe, expect, it, vi } from "vitest";
import {
  hashToHex,
  parseNodeBytes,
  sha256,
} from "@unicas/codec";
import type {
  CasGcOptions,
  CasGcResult,
  CasLeaseOptions,
  CasLeaseResult,
  CasNodeMetadata,
  CasNodeRange,
  CasNodeSource,
  CasRootRefUpdate,
  CasRootRefsResult,
  CasUsage,
  TenantCasClient,
} from "@unicas/tenant-client";
import { createCasBlobClient, storeNodeContent } from "../src/index.js";

class MemoryCas implements TenantCasClient {
  readonly nodes = new Map<string, { content: Uint8Array; contentType: string; refs: string[] }>();
  readonly rootRefUpdates: CasRootRefUpdate[] = [];
  gcCalls: { maxNodes?: number }[] = [];

  async leaseNode(
    hash: string,
    source?: CasNodeSource,
    _options?: CasLeaseOptions,
  ): Promise<CasLeaseResult> {
    if (source === undefined) {
      if (!this.nodes.has(hash)) throw new Error(`node not found: ${hash}`);
      return { hash, ready: true, leaseStartedAt: 0, leaseExpiresAt: Date.now() + 60_000 };
    }
    const canonical = new Uint8Array(await new Response(source.body).arrayBuffer());
    const parsed = parseNodeBytes(canonical);
    this.nodes.set(hash, {
      content: parsed.content,
      contentType: parsed.contentType,
      refs: parsed.childHashes.map(hashToHex),
    });
    return { hash, ready: true, leaseStartedAt: 0, leaseExpiresAt: Date.now() + 60_000 };
  }

  async readMetadata(hash: string): Promise<CasNodeMetadata> {
    const node = this.nodes.get(hash);
    if (node === undefined) throw new Error(`node not found: ${hash}`);
    return { hash, size: node.content.length, contentType: node.contentType, refs: node.refs };
  }

  async readContent(
    hash: string,
    range?: CasNodeRange,
    _options?: { readonly signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>> {
    const node = this.nodes.get(hash);
    if (node === undefined) throw new Error(`node not found: ${hash}`);
    const content = range === undefined
      ? node.content
      : node.content.slice(range.offset, range.length === undefined ? undefined : range.offset + range.length);
    return streamBytes(content);
  }

  async updateRootRefs(update: CasRootRefUpdate): Promise<CasRootRefsResult> {
    this.rootRefUpdates.push(update);
    return { success: true, revision: this.rootRefUpdates.length };
  }

  async usage(): Promise<CasUsage> {
    return {
      nodeCount: this.nodes.size,
      readyContentBytes: [...this.nodes.values()].reduce((total, node) => total + node.content.length, 0),
      readyStoredBytes: 0,
      reservedBytes: 0,
      notReadyNodeCount: 0,
      leasedNodeCount: this.nodes.size,
    };
  }

  async gc(options?: CasGcOptions): Promise<CasGcResult> {
    this.gcCalls.push(options ?? {});
    return { examined: this.nodes.size, deleted: 0, reclaimedContentBytes: 0 };
  }
}

describe("functional blob client", () => {
  it("stores and reads deterministic chunk-tree blobs", async () => {
    const cas = new MemoryCas();
    const leaseNode = vi.spyOn(cas, "leaseNode");
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
      leaseDurationMs: 30 * 60 * 1000,
      onProgress: progress,
    });
    expect(leaseNode).toHaveBeenCalledTimes(cas.nodes.size);
    expect(leaseNode).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.any(ReadableStream) }),
      { durationMs: 30 * 60 * 1000, signal: undefined },
    );
    expect(leaseNode.mock.calls.every(call => call[2]?.durationMs === 30 * 60 * 1000)).toBe(true);
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
    expect(blobs.unicasClient).toBe(cas);
    await expect(blobs.unicasClient.usage()).resolves.toBeDefined();
    await expect(blobs.unicasClient.gc({ maxNodes: 25 })).resolves.toBeDefined();
    expect(progress).toHaveBeenLastCalledWith(bytes.length);
  }, 20_000);

  it("resolves single-node metadata when opening a blob", async () => {
    const cas = new MemoryCas();
    const blobs = createCasBlobClient(cas, { chunkBytes: 1024, indexFanout: 2 });
    const bytes = new TextEncoder().encode("small");
    const ref = await blobs.storeBlob(streamOf(bytes, 3), {
      contentType: "text/plain",
      size: bytes.length,
    });
    expect(ref.size).toBe(bytes.length);
    expect(ref.contentType).toBe("text/plain");
    expect((await blobs.openBlob(ref.hash)).ref).toEqual(ref);
  });

  it("separates batch retain and release while exposing the tenant client", async () => {
    const cas = new MemoryCas();
    const blobs = createCasBlobClient(cas);
    const bytes = new TextEncoder().encode("abc");
    const hash = await storeNodeContent(cas, bytes, "text/plain");

    await expect(blobs.unicasClient.leaseNode(hash)).resolves.toMatchObject({ hash, ready: true });
    await expect(blobs.retain({ requestId: "retain-1", references: { [hash]: 2 } }))
      .resolves.toMatchObject({ success: true, revision: 1 });
    await expect(blobs.release({ requestId: "release-1", references: { [hash]: 1 } }))
      .resolves.toMatchObject({ success: true, revision: 2 });
    await expect(blobs.unicasClient.gc({ maxNodes: 25 })).resolves.toBeDefined();
    expect(cas.rootRefUpdates).toEqual([
      { requestId: "retain-1", changes: { [hash]: 2 } },
      { requestId: "release-1", changes: { [hash]: -1 } },
    ]);
    expect(cas.gcCalls).toEqual([{ maxNodes: 25 }]);
  });

  it("rejects non-positive retention counts before calling the tenant client", async () => {
    const cas = new MemoryCas();
    const blobs = createCasBlobClient(cas);

    await expect(blobs.retain({ requestId: "invalid", references: { bad: 0 } }))
      .rejects.toThrow("positive safe integer");
    expect(cas.rootRefUpdates).toEqual([]);
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

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}
