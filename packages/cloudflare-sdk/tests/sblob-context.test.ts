import { describe, expect, it, vi } from "vitest";
import { computeNodeDigest, encodeHeader, hashToHex, hexToHash } from "@unicas/server-common";
import { SValueContentType } from "@unidocs/protocol";
import { encodeSValueWithRefs } from "@unidocs/svalue-codec/internal";
import { CasClientError } from "@unicas/client";
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
  readonly ensureNode = vi.fn(async (
    hash: string,
    data: Uint8Array,
    contentType: string,
    refs: readonly string[] = [],
  ) => {
    this.nodes.set(hash, { data: data.slice(), contentType, refs: [...refs] });
  });
  readonly leaseExisting = vi.fn(async (hash: string) => {
    if (!this.nodes.has(hash)) throw new CasClientError(404, "Not Found", "leaseExisting");
  });
  readonly metadata = vi.fn(async (hash: string) => {
    const node = this.nodes.get(hash);
    if (!node) throw new CasClientError(404, "Not Found", "metadata");
    return { hash, size: node.data.length, contentType: node.contentType, refs: node.refs };
  });
  readonly read = vi.fn(async (hash: string) => {
    const node = this.nodes.get(hash);
    if (!node) throw new CasClientError(404, "Not Found", "read");
    return node.data.slice();
  });
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
    expect(cas.ensureNode).toHaveBeenCalledTimes(1);
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
    cas.leaseExisting.mockClear();
    const encoded = encodeSValueWithRefs([child, child]);

    await context.makeSBlob({ data: encoded.data, contentType: SValueContentType });

    expect(cas.leaseExisting).toHaveBeenCalledTimes(2);
    expect(cas.leaseExisting).toHaveBeenNthCalledWith(1, expect.any(String));
    expect(cas.leaseExisting).toHaveBeenNthCalledWith(2, child.hash);
    const parent = [...cas.nodes.values()].find(node => node.contentType === SValueContentType);
    expect(parent?.refs).toEqual([child.hash, child.hash]);
  });

  it("verifies reads, coalesces them, and returns defensive byte copies", async () => {
    const cas = new FakeCas();
    const writer = createSBlobContext(cas);
    const blob = await writer.makeSBlob({
      data: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
    });
    const reader = createSBlobContext(cas);

    const [first, concurrent] = await Promise.all([
      reader.readSBlob(blob),
      reader.readSBlob(blob),
    ]);
    first.data[0] = 99;
    const second = await reader.readSBlob(blob);

    expect(concurrent.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(second.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(cas.read).toHaveBeenCalledTimes(1);
    expect(cas.metadata).toHaveBeenCalledTimes(1);
  });

  it("rejects corrupted content and SValue metadata", async () => {
    const cas = new FakeCas();
    const context = createSBlobContext(cas);
    const blob = await context.makeSBlob({
      data: new TextEncoder().encode("intact"),
      contentType: "text/plain",
    });
    cas.nodes.get(blob.hash)!.data[0] ^= 0xff;

    await expect(createSBlobContext(cas).readSBlob(blob))
      .rejects.toBeInstanceOf(SBlobIntegrityError);
  });

  it("evicts least-recently-used entries at the configured bound", async () => {
    const cas = new FakeCas();
    const writer = createSBlobContext(cas);
    const first = await writer.makeSBlob({
      data: new Uint8Array([1]),
      contentType: "application/octet-stream",
    });
    const second = await writer.makeSBlob({
      data: new Uint8Array([2]),
      contentType: "application/octet-stream",
    });
    cas.read.mockClear();
    const reader = createSBlobContext(cas, { maxCacheEntries: 1 });

    await reader.readSBlob(first);
    await reader.readSBlob(second);
    await reader.readSBlob(first);

    expect(cas.read).toHaveBeenCalledTimes(3);
  });

  it("does not share authorized cache entries between contexts", async () => {
    const cas = new FakeCas();
    const writer = createSBlobContext(cas);
    const blob = await writer.makeSBlob({
      data: new Uint8Array([7]),
      contentType: "application/octet-stream",
    });
    cas.read.mockClear();

    await createSBlobContext(cas).readSBlob(blob);
    await createSBlobContext(cas).readSBlob(blob);

    expect(cas.read).toHaveBeenCalledTimes(2);
  });
});