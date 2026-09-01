import { describe, expect, it, vi } from "vitest";
import { computeNodeDigest, encodeHeader, hashToHex, hexToHash } from "@unicas/codec";
import { SValueContentType } from "@unidocs/protocol";
import type { SBlobReadRange, SBlobSource } from "@unidocs/protocol";
import { encodeSValueWithRefs } from "@unidocs/svalue-codec/internal";
import { CasClientError } from "@unicas/tenant-client";
import {
  createSBlobContext,
  SBlobIntegrityError,
} from "../src/sblob-context.js";

interface Node {
  data: Uint8Array;
  contentType: string;
  refs: readonly string[];
}

class FakeCas {
  readonly nodes = new Map<string, Node>();
  readonly leaseNodeContent = vi.fn(async (
    hash: string,
    data: Uint8Array,
    contentType: string,
    refs: readonly string[] = [],
  ) => {
    this.nodes.set(hash, { data: data.slice(), contentType, refs: [...refs] });
  });
  readonly leaseNode = vi.fn(async (hash: string) => {
    if (!this.nodes.has(hash)) throw new CasClientError(404, "Not Found", "lease");
  });
  readonly metadata = vi.fn(async (hash: string) => {
    const node = this.nodes.get(hash);
    if (!node) throw new CasClientError(404, "Not Found", "metadata");
    return { hash, size: node.data.length, contentType: node.contentType, refs: node.refs };
  });
  readonly storeBlob = vi.fn(async (source: SBlobSource) => {
    const data = "data" in source ? source.data : await collect(source.body);
    const node = { data: data.slice(), contentType: source.contentType, refs: [] };
    const hash = await nodeHash(node);
    this.nodes.set(hash, node);
    return { hash };
  });
  readonly openBlob = vi.fn(async (hash: string) => {
    const node = this.nodes.get(hash);
    if (!node) throw new CasClientError(404, "Not Found", "openBlob");
    const read = (range?: SBlobReadRange) => {
      const start = range?.offset ?? 0;
      const end = range?.length === undefined ? node.data.length : start + range.length;
      return streamBytes(node.data.slice(start, end));
    };
    return Object.freeze({
      ref: { hash, size: node.data.length, contentType: node.contentType },
      read,
      async readBytes(range: { readonly offset: number; readonly length: number }) {
        return node.data.slice(range.offset, range.offset + range.length);
      },
    });
  });
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    size += chunk.length;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function nodeHash(node: Node): Promise<string> {
  const children = node.refs.map(hexToHash);
  return hashToHex(await computeNodeDigest(
    encodeHeader(node.data.length, node.contentType, children.length),
    node.contentType,
    children,
    node.data,
  ));
}

describe("SBlob context", () => {
  it("does not invoke a lazy loader for an existing node", async () => {
    const cas = new FakeCas();
    const context = createSBlobContext(cas);
    const data = { data: new TextEncoder().encode("known"), contentType: "text/plain" };
    const stored = await context.makeSBlob(data);
    const loadData = vi.fn(async () => data);

    const leased = await context.makeSBlob(stored.hash, loadData);

    expect(leased.hash).toBe(stored.hash);
    expect(loadData).not.toHaveBeenCalled();
    expect(cas.storeBlob).toHaveBeenCalledTimes(1);
  });

  it("calls a missing-node loader once and validates its expected hash", async () => {
    const cas = new FakeCas();
    const context = createSBlobContext(cas);
    const data = { data: new TextEncoder().encode("new"), contentType: "text/plain" };
    const expected = await nodeHash({ ...data, refs: [] });
    const loadData = vi.fn(async () => data);

    await expect(Promise.all([
      context.makeSBlob(expected, loadData),
      context.makeSBlob(expected, loadData),
    ])).resolves.toHaveLength(2);
    expect(loadData).toHaveBeenCalledTimes(1);

    await expect(context.makeSBlob("a".repeat(64), async () => data))
      .rejects.toBeInstanceOf(SBlobIntegrityError);
  });

  it("derives SValue refs and leases each distinct child", async () => {
    const cas = new FakeCas();
    const context = createSBlobContext(cas);
    const child = await context.makeSBlob({
      data: new TextEncoder().encode("child"),
      contentType: "text/plain",
    });
    cas.leaseNode.mockClear();
    const encoded = encodeSValueWithRefs([child, child]);

    await context.makeSBlob({ data: encoded.data, contentType: SValueContentType });

    expect(cas.leaseNode).toHaveBeenCalledTimes(1);
    expect(cas.leaseNode).toHaveBeenCalledWith(child.hash);
    const parent = [...cas.nodes.values()].find(node => node.contentType === SValueContentType);
    expect(parent?.refs).toEqual([child.hash, child.hash]);
  });

  it("opens reusable handlers and reads exact logical ranges", async () => {
    const cas = new FakeCas();
    const writer = createSBlobContext(cas);
    const blob = await writer.makeSBlob({
      data: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
    });
    const reader = createSBlobContext(cas);

    const handler = await reader.openSBlob(blob);
    const first = await handler.readBytes({ offset: 0, length: 3 });
    first[0] = 99;
    const second = await handler.readBytes({ offset: 1, length: 2 });

    expect(second).toEqual(new Uint8Array([2, 3]));
    expect(await collect(handler.read())).toEqual(new Uint8Array([1, 2, 3]));
    expect(cas.openBlob).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched metadata identity", async () => {
    const cas = new FakeCas();
    const context = createSBlobContext(cas);
    const blob = await context.makeSBlob({
      data: new TextEncoder().encode("intact"),
      contentType: "text/plain",
    });
    cas.openBlob.mockResolvedValueOnce(Object.freeze({
      ref: { hash: "f".repeat(64), size: 6, contentType: "text/plain" },
      read: () => streamBytes(new Uint8Array(0)),
      readBytes: async () => new Uint8Array(0),
    }));

    await expect(createSBlobContext(cas).openSBlob(blob))
      .rejects.toBeInstanceOf(SBlobIntegrityError);
  });

  it("rejects unbounded materialization beyond the configured limit", async () => {
    const cas = new FakeCas();
    const writer = createSBlobContext(cas);
    const blob = await writer.makeSBlob({
      data: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
    });
    const handler = await createSBlobContext(cas, { maxReadBytes: 2 }).openSBlob(blob);

    await expect(handler.readBytes({ offset: 0, length: 3 })).rejects.toThrow("materialization limit");
  });

  it("validates requested ranges before opening CAS", async () => {
    const cas = new FakeCas();
    const writer = createSBlobContext(cas);
    const blob = await writer.makeSBlob({
      data: new Uint8Array([7]),
      contentType: "application/octet-stream",
    });
    const handler = await createSBlobContext(cas).openSBlob(blob);

    expect(() => handler.read({ offset: 2, length: 1 })).toThrow("outside the blob");
    expect(cas.openBlob).toHaveBeenCalledTimes(1);
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