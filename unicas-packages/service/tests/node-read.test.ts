import { describe, expect, test } from "vitest";
import {
  NodeOpError,
  parseNodeContentRange,
  readNodeContent,
  readNodeMetadata,
  type NodeReadRecord,
  type NodeReadRepository,
  type NodeReadScope,
} from "../src/index.js";

const SCOPE = { stackId: "cas_stack_a", tenantId: "tenant-1" };
const NODE: NodeReadRecord = {
  contentSize: 10,
  contentType: "text/plain",
  leaseStartedAt: 100,
  leaseExpiresAt: 200,
  childRefCount: 2,
  rootRefCount: 3,
};

class MemoryNodeReadRepository implements NodeReadRepository {
  node: NodeReadRecord | null = NODE;
  refs = ["child-a", "child-b"];
  canonical = new Uint8Array(200).map((_, index) => index);
  requestedRange: { offset: number; length: number } | undefined;

  async readNode(_scope: NodeReadScope, _hash: string) {
    return this.node;
  }

  async readOrderedRefs(_scope: NodeReadScope, _hash: string) {
    return this.refs;
  }

  async readCanonicalRange(
    _scope: NodeReadScope,
    _hash: string,
    range: { readonly offset: number; readonly length: number },
  ) {
    this.requestedRange = range;
    const bytes = this.canonical.slice(range.offset, range.offset + range.length);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
}

describe("node read service kernel", () => {
  test("parses complete, open-ended, bounded, and suffix ranges", () => {
    expect(parseNodeContentRange(null, 10)).toBeUndefined();
    expect(parseNodeContentRange("bytes=2-5", 10)).toEqual({ offset: 2, length: 4 });
    expect(parseNodeContentRange("bytes=7-", 10)).toEqual({ offset: 7, length: 3 });
    expect(parseNodeContentRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
    expect(parseNodeContentRange("bytes=2-50", 10)).toEqual({ offset: 2, length: 8 });
  });

  test("rejects unsatisfiable ranges with the wire-compatible response header", () => {
    for (const [header, size] of [["bytes=10-", 10], ["bytes=-0", 10], ["bytes=", 10], ["bytes=0-0", 0]] as const) {
      expect(() => parseNodeContentRange(header, size)).toThrow(NodeOpError);
      try {
        parseNodeContentRange(header, size);
      } catch (error) {
        expect(error).toMatchObject({
          status: 416,
          code: "INVALID_REQUEST",
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
    }
  });

  test("maps logical ranges to canonical payload offsets", async () => {
    const repository = new MemoryNodeReadRepository();
    const result = await readNodeContent({
      repository,
      scope: SCOPE,
      hash: "node",
      rangeHeader: "bytes=2-5",
    });

    expect(repository.requestedRange).toEqual({ offset: 100, length: 4 });
    expect(result).toMatchObject({
      contentType: "text/plain",
      contentSize: 10,
      range: { start: 2, end: 5 },
    });
  });

  test("shapes metadata and lifecycle state from semantic records", async () => {
    const repository = new MemoryNodeReadRepository();
    await expect(readNodeMetadata({ repository, scope: SCOPE, hash: "node" })).resolves.toEqual({
      metadata: { hash: "node", size: 10, contentType: "text/plain", refs: ["child-a", "child-b"] },
      state: { leaseStartedAt: 100, leaseExpiresAt: 200, childRefCount: 2, rootRefCount: 3 },
    });
  });

  test("returns null without reading refs or content when metadata is absent", async () => {
    const repository = new MemoryNodeReadRepository();
    repository.node = null;
    repository.refs = [];
    await expect(readNodeContent({ repository, scope: SCOPE, hash: "missing" })).resolves.toBeNull();
    await expect(readNodeMetadata({ repository, scope: SCOPE, hash: "missing" })).resolves.toBeNull();
    expect(repository.requestedRange).toBeUndefined();
  });
});
