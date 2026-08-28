import {
  computeNodeDigest,
  concatenateNodeBytes,
  encodeHeader,
  hashToHex,
  hexToHash,
} from "@unicas/server-common";
import {
  BlobChunkBytes,
  BlobChunkContentType,
  BlobIndexContentType,
  BlobIndexFanout,
  decodeBlobIndex,
  encodeBlobIndex,
} from "@unicas/protocol";
import type {
  CasBlobClient,
  CasBlobClientOptions,
  CasBlobRef,
  CasBlobSource,
  CasBlobWriteOptions,
  CasLeaseOptions,
  CasLeaseResult,
  CasNodeRange,
  TenantCasClient,
} from "./types.js";

interface BlobTreeNode {
  readonly hash: string;
  readonly size: number;
  readonly level: number;
}

type BlobCas = Pick<TenantCasClient, "node" | "leaseNode">;

async function encodeCanonicalNode(
  content: Uint8Array,
  contentType: string,
  refs: readonly string[],
): Promise<{ readonly hash: string; readonly bytes: Uint8Array }> {
  const childHashes = refs.map(hexToHash);
  const header = encodeHeader(content.length, contentType, childHashes.length);
  return {
    hash: hashToHex(await computeNodeDigest(header, contentType, childHashes, content)),
    bytes: concatenateNodeBytes(
      header,
      new TextEncoder().encode(contentType),
      childHashes,
      content,
    ),
  };
}

export async function leaseNodeContent(
  cas: Pick<TenantCasClient, "leaseNode">,
  hash: string,
  content: Uint8Array,
  contentType: string,
  refs: readonly string[] = [],
  options?: CasLeaseOptions,
): Promise<CasLeaseResult> {
  const canonical = await encodeCanonicalNode(content, contentType, refs);
  if (canonical.hash !== hash) {
    throw new Error(`CAS node digest mismatch: expected ${hash}, got ${canonical.hash}`);
  }
  return cas.leaseNode(hash, {
    contentLength: canonical.bytes.length,
    body: streamBytes(canonical.bytes),
  }, options);
}

export async function storeNodeContent(
  cas: Pick<TenantCasClient, "leaseNode">,
  content: Uint8Array,
  contentType: string,
  refs: readonly string[] = [],
  options?: CasLeaseOptions,
): Promise<string> {
  const canonical = await encodeCanonicalNode(content, contentType, refs);
  await cas.leaseNode(canonical.hash, {
    contentLength: canonical.bytes.length,
    body: streamBytes(canonical.bytes),
  }, options);
  return canonical.hash;
}

export function createCasBlobClient(
  cas: BlobCas,
  options: CasBlobClientOptions = {},
): CasBlobClient {
  const chunkBytes = options.chunkBytes ?? BlobChunkBytes;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > BlobChunkBytes) {
    throw new RangeError(`Blob chunk size must be an integer between 1 and ${BlobChunkBytes}`);
  }
  const indexFanout = options.indexFanout ?? BlobIndexFanout;
  if (!Number.isSafeInteger(indexFanout) || indexFanout < 2 || indexFanout > BlobIndexFanout) {
    throw new RangeError(`Blob index fanout must be an integer between 2 and ${BlobIndexFanout}`);
  }
  const storeNode = async (
    content: Uint8Array,
    contentType: string,
    refs: readonly string[] = [],
  ): Promise<string> => {
    return storeNodeContent(cas, content, contentType, refs);
  };

  const storeIndex = async (
    children: readonly BlobTreeNode[],
    mediaType: string,
  ): Promise<BlobTreeNode> => {
    const level = children[0].level + 1;
    if (children.some(child => child.level !== level - 1)) {
      throw new Error("Blob tree index children must have the same level");
    }
    const size = children.reduce((total, child) => total + child.size, 0);
    const content = encodeBlobIndex({
      version: 1,
      level,
      size,
      mediaType,
      children: children.map(child => ({ size: child.size })),
    });
    return {
      hash: await storeNode(content, BlobIndexContentType, children.map(child => child.hash)),
      size,
      level,
    };
  };

  const appendTreeNode = async (
    groups: BlobTreeNode[][],
    node: BlobTreeNode,
    mediaType: string,
  ): Promise<void> => {
    const groupIndex = node.level + 1;
    const group = groups[groupIndex] ??= [];
    group.push(node);
    if (group.length === indexFanout) {
      groups[groupIndex] = [];
      await appendTreeNode(groups, await storeIndex(group, mediaType), mediaType);
    }
  };

  const finishTree = async (groups: BlobTreeNode[][], mediaType: string): Promise<BlobTreeNode> => {
    while (true) {
      const populated = groups
        .map((group, index) => ({ group, index }))
        .filter(entry => entry.group.length > 0);
      const count = populated.reduce((total, entry) => total + entry.group.length, 0);
      if (count === 1) return populated[0].group[0];
      const lowest = populated[0];
      groups[lowest.index] = [];
      await appendTreeNode(groups, await storeIndex(lowest.group, mediaType), mediaType);
    }
  };

  const statBlob = async (hash: string): Promise<CasBlobRef> => {
    const node = cas.node(hash);
    const metadata = await node.metadata();
    if (metadata.contentType !== BlobIndexContentType) {
      if (metadata.refs.length !== 0) throw new Error(`CAS node ${hash} is not a blob root`);
      return { hash, size: metadata.size, contentType: metadata.contentType };
    }
    const index = decodeBlobIndex(await collectStream(await node.read()));
    if (index.children.length !== metadata.refs.length) {
      throw new Error(`Blob index ${hash} child metadata does not match its CAS refs`);
    }
    return { hash, size: index.size, contentType: index.mediaType };
  };

  const resolveBlob = async (ref: CasBlobRef | string): Promise<CasBlobRef> => {
    const resolved = await statBlob(typeof ref === "string" ? ref : ref.hash);
    if (typeof ref !== "string" && (ref.size !== resolved.size || ref.contentType !== resolved.contentType)) {
      throw new Error(`Blob ref metadata mismatch for ${ref.hash}`);
    }
    return resolved;
  };

  const readNode = async function* (
    hash: string,
    expectedLevel: number | undefined,
    expectedMediaType: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    signal?.throwIfAborted();
    const node = cas.node(hash);
    const metadata = await node.metadata();
    if (metadata.contentType !== BlobIndexContentType) {
      validateLeaf(hash, metadata.refs, metadata.contentType, expectedLevel);
      yield* readStream(await node.read(), signal);
      return;
    }
    const index = decodeBlobIndex(await collectStream(await node.read()));
    validateIndex(hash, index.mediaType, index.level, index.children.length, metadata.refs.length, expectedLevel, expectedMediaType);
    for (let child = 0; child < metadata.refs.length; child++) {
      yield* readNode(metadata.refs[child], index.level - 1, expectedMediaType, signal);
    }
  };

  const readRangeNode = async function* (
    hash: string,
    offset: number,
    length: number,
    expectedLevel: number | undefined,
    expectedMediaType: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    signal?.throwIfAborted();
    const node = cas.node(hash);
    const metadata = await node.metadata();
    if (metadata.contentType !== BlobIndexContentType) {
      validateLeaf(hash, metadata.refs, metadata.contentType, expectedLevel);
      yield* readStream(await node.read({ offset, length }), signal);
      return;
    }
    const index = decodeBlobIndex(await collectStream(await node.read()));
    validateIndex(hash, index.mediaType, index.level, index.children.length, metadata.refs.length, expectedLevel, expectedMediaType);
    const end = offset + length;
    let childStart = 0;
    for (let child = 0; child < index.children.length; child++) {
      const childEnd = childStart + index.children[child].size;
      const intersectionStart = Math.max(offset, childStart);
      const intersectionEnd = Math.min(end, childEnd);
      if (intersectionStart < intersectionEnd) {
        yield* readRangeNode(
          metadata.refs[child],
          intersectionStart - childStart,
          intersectionEnd - intersectionStart,
          index.level - 1,
          expectedMediaType,
          signal,
        );
      }
      if (childEnd >= end) return;
      childStart = childEnd;
    }
  };

  return Object.freeze({
    async storeBlob(source: CasBlobSource, options: CasBlobWriteOptions): Promise<CasBlobRef> {
      const chunks = chunkSource(
        source instanceof Blob ? source.stream() : source,
        chunkBytes,
        options.signal,
      );
      const first = await chunks.next();
      if (first.done) {
        const hash = await storeNode(new Uint8Array(0), options.contentType);
        assertExpectedSize(options.size, 0);
        return { hash, size: 0, contentType: options.contentType };
      }
      const second = await chunks.next();
      if (second.done) {
        const hash = await storeNode(first.value, options.contentType);
        assertExpectedSize(options.size, first.value.length);
        options.onProgress?.(first.value.length);
        return { hash, size: first.value.length, contentType: options.contentType };
      }

      const groups: BlobTreeNode[][] = [];
      let measuredSize = 0;
      const addChunk = async (bytes: Uint8Array): Promise<void> => {
        const hash = await storeNode(bytes, BlobChunkContentType);
        measuredSize += bytes.length;
        options.onProgress?.(measuredSize);
        await appendTreeNode(groups, { hash, size: bytes.length, level: -1 }, options.contentType);
      };
      await addChunk(first.value);
      await addChunk(second.value);
      for await (const bytes of chunks) await addChunk(bytes);

      const root = await finishTree(groups, options.contentType);
      assertExpectedSize(options.size, measuredSize);
      return { hash: root.hash, size: measuredSize, contentType: options.contentType };
    },

    statBlob,

    async openBlob(ref: CasBlobRef | string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
      const resolved = await resolveBlob(ref);
      return streamGenerator(readNode(resolved.hash, undefined, resolved.contentType, signal));
    },

    async openBlobRange(
      ref: CasBlobRef | string,
      range: CasNodeRange,
      signal?: AbortSignal,
    ): Promise<ReadableStream<Uint8Array>> {
      validateRange(range);
      const resolved = await resolveBlob(ref);
      if (range.offset > resolved.size) throw new RangeError("Blob range offset exceeds blob size");
      const length = Math.min(range.length ?? resolved.size - range.offset, resolved.size - range.offset);
      if (length === 0) return streamBytes(new Uint8Array(0));
      return streamGenerator(readRangeNode(
        resolved.hash,
        range.offset,
        length,
        undefined,
        resolved.contentType,
        signal,
      ));
    },
  });
}

function validateLeaf(
  hash: string,
  refs: readonly string[],
  contentType: string,
  expectedLevel: number | undefined,
): void {
  if (refs.length !== 0) throw new Error(`CAS node ${hash} is not a blob leaf`);
  if (expectedLevel !== undefined && (expectedLevel !== -1 || contentType !== BlobChunkContentType)) {
    throw new Error(`Blob tree leaf ${hash} has an invalid type or level`);
  }
}

function validateIndex(
  hash: string,
  mediaType: string,
  level: number,
  childCount: number,
  refCount: number,
  expectedLevel: number | undefined,
  expectedMediaType: string,
): void {
  if (
    mediaType !== expectedMediaType
    || (expectedLevel !== undefined && level !== expectedLevel)
    || childCount !== refCount
  ) {
    throw new Error(`Blob index ${hash} metadata is inconsistent`);
  }
}

function validateRange(range: CasNodeRange): void {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
    throw new TypeError("Blob range offset must be a non-negative safe integer");
  }
  if (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0)) {
    throw new TypeError("Blob range length must be a non-negative safe integer");
  }
}

async function* readStream(
  source: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function streamGenerator(iterator: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return(undefined);
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

async function* chunkSource(
  source: ReadableStream<Uint8Array>,
  chunkBytes: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  let chunk = new Uint8Array(chunkBytes);
  let used = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      let offset = 0;
      while (offset < next.value.length) {
        const take = Math.min(chunkBytes - used, next.value.length - offset);
        chunk.set(next.value.subarray(offset, offset + take), used);
        used += take;
        offset += take;
        if (used === chunkBytes) {
          yield chunk;
          chunk = new Uint8Array(chunkBytes);
          used = 0;
        }
      }
    }
    if (used > 0) yield chunk.slice(0, used);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function collectStream(source: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(source).arrayBuffer());
}

function assertExpectedSize(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error(`Blob size mismatch: expected ${expected}, got ${actual}`);
  }
}