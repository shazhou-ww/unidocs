import { HASH_SIZE, HEADER_SIZE } from "@unicas/codec";
import type { CasNodeMetadata, CasNodeState } from "@unicas/tenant-protocol";
import { NodeOpError, NodeOpErrorCodes } from "./node-errors.js";

export interface NodeReadScope {
  readonly stackId: string;
  readonly tenantId: string;
}

export interface NodeReadRecord {
  readonly contentSize: number;
  readonly contentType: string;
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
  readonly childRefCount: number;
  readonly rootRefCount: number;
}

export interface NodeReadRepository {
  readNode(scope: NodeReadScope, hash: string): Promise<NodeReadRecord | null>;
  readOrderedRefs(scope: NodeReadScope, hash: string): Promise<readonly string[]>;
  readCanonicalRange(
    scope: NodeReadScope,
    hash: string,
    range: { readonly offset: number; readonly length: number },
  ): Promise<ReadableStream<Uint8Array> | null>;
}

export interface NodeContentStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
  readonly contentSize: number;
  readonly range?: { readonly start: number; readonly end: number };
}

export async function readNodeContent(input: {
  readonly repository: NodeReadRepository;
  readonly scope: NodeReadScope;
  readonly hash: string;
  readonly rangeHeader?: string | null;
}): Promise<NodeContentStream | null> {
  const node = await input.repository.readNode(input.scope, input.hash);
  if (node === null) return null;
  const refs = await input.repository.readOrderedRefs(input.scope, input.hash);
  const requestedRange = parseNodeContentRange(input.rangeHeader ?? null, node.contentSize);
  const logicalOffset = requestedRange?.offset ?? 0;
  const logicalLength = requestedRange?.length ?? node.contentSize;
  const physicalOffset = HEADER_SIZE
    + new TextEncoder().encode(node.contentType).length
    + refs.length * HASH_SIZE;
  const body = await input.repository.readCanonicalRange(input.scope, input.hash, {
    offset: physicalOffset + logicalOffset,
    length: logicalLength,
  });
  if (body === null) return null;
  return {
    body,
    contentType: node.contentType,
    contentSize: node.contentSize,
    ...(requestedRange === undefined
      ? {}
      : { range: { start: logicalOffset, end: logicalOffset + logicalLength - 1 } }),
  };
}

export async function readNodeMetadata(input: {
  readonly repository: NodeReadRepository;
  readonly scope: NodeReadScope;
  readonly hash: string;
}): Promise<{ metadata: CasNodeMetadata; state: CasNodeState } | null> {
  const node = await input.repository.readNode(input.scope, input.hash);
  if (node === null) return null;
  const refs = await input.repository.readOrderedRefs(input.scope, input.hash);
  return {
    metadata: {
      hash: input.hash,
      size: node.contentSize,
      contentType: node.contentType,
      refs: [...refs],
    },
    state: {
      leaseStartedAt: node.leaseStartedAt,
      leaseExpiresAt: node.leaseExpiresAt,
      childRefCount: node.childRefCount,
      rootRefCount: node.rootRefCount,
    },
  };
}

export function parseNodeContentRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | undefined {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (match[1] === "" && match[2] === "") || size === 0) {
    throw rangeNotSatisfiable(size);
  }
  const first = match[1] === "" ? undefined : Number(match[1]);
  const last = match[2] === "" ? undefined : Number(match[2]);
  if (
    (first !== undefined && (!Number.isSafeInteger(first) || first < 0))
    || (last !== undefined && (!Number.isSafeInteger(last) || last < 0))
  ) {
    throw rangeNotSatisfiable(size);
  }
  if (first === undefined) {
    if (last === undefined || last === 0) throw rangeNotSatisfiable(size);
    const length = Math.min(last, size);
    return { offset: size - length, length };
  }
  if (first >= size || (last !== undefined && last < first)) {
    throw rangeNotSatisfiable(size);
  }
  const end = last === undefined ? size - 1 : Math.min(last, size - 1);
  return { offset: first, length: end - first + 1 };
}

function rangeNotSatisfiable(size: number): NodeOpError {
  return new NodeOpError(416, NodeOpErrorCodes.INVALID_REQUEST, "Range is not satisfiable", {
    "Content-Range": `bytes */${size}`,
  });
}