/**
 * CAS HTTP client for @unicas/client.
 *
 * Public mode talks to Gateway (`baseUrl` + tenant identity + optional Bearer).
 * Editor mode talks to the CAS worker through a fetch-capable binding using
 * either the legacy shared headers or one request-local delegated capability.
 * which is structural so this package stays cloud-neutral (no Cloudflare
 * `Fetcher` type import). CAS wire types live in @unicas/protocol-legacy.
 */

export type {
  CasGcOptions,
  CasHttpFetcher,
  CasLeaseOptions,
  CasNodeCache,
  CasNodeCacheKey,
  CasNodeRange,
  CasNodeReader,
  CasNodeSource,
  CasRootRefsResult,
  HttpFetcher,
  TenantCasClient,
  TenantCasClientConfig,
} from "./types.js";
export { createTenantCasClient } from "./client.js";
export { CasClientError } from "./errors.js";

import { CasClientError } from "./errors.js";
import type { CasRootRefsResult, HttpFetcher } from "./types.js";

import {
  CanonicalNodeContentType,
  computeNodeDigest,
  concatenateNodeBytes,
  encodeHeader,
  hashToHex,
  hexToHash,
} from "@unicas/server-common";
import { refsFromSValue } from "@unidocs/svalue-codec";
import type { CasRef, CasReadContext, CasReferences, SValue } from "@unidocs/protocol";
import {
  BlobChunkBytes,
  BlobChunkContentType,
  BlobIndexContentType,
  BlobIndexFanout,
  casRoutes as canonicalCasRoutes,
  decodeBlobIndex,
  encodeBlobIndex,
} from "@unicas/protocol";
import { casRoutes as legacyCasRoutes } from "@unicas/protocol-legacy";
import type { CasLeaseResult, CasRootRefUpdate } from "@unicas/protocol-legacy";

export type CasClientConfig =
  | { baseUrl: string; tenantId: string; authToken?: string }
  | { baseUrl: string; stackId: string; tenantId: string; authToken?: string }
  | { fetcher: HttpFetcher; tenantId: string; accessKey: string }
  | {
    fetcher: HttpFetcher;
    tenantId: string;
    sessionId: string;
    capability: string;
    stackId?: string;
  };

/** The optional stack namespace; canonical routes are used only when present. */
function stackIdOf(config: CasClientConfig): string | undefined {
  return "stackId" in config ? config.stackId : undefined;
}

/** Tenant route builder: canonical `/stacks/...` when stackId is present. */
function tenantRoutesFor(config: CasClientConfig): {
  readContent: (hash: string) => string;
  readMetadata: (hash: string) => string;
  leaseNode: (hash: string) => string;
  leaseExisting: (hash: string) => string;
  unifiedLease: (hash: string) => string;
  usage: () => string;
  gc: () => string;
  rootRefs: () => string;
} {
  const tenantId = config.tenantId;
  const stackId = stackIdOf(config);
  if (stackId !== undefined) {
    return {
      readContent: hash => canonicalCasRoutes.readContent({ stackId, tenantId, hash }),
      readMetadata: hash => canonicalCasRoutes.readMetadata({ stackId, tenantId, hash }),
      leaseNode: hash => canonicalCasRoutes.leaseNode({ stackId, tenantId, hash }),
      leaseExisting: hash => canonicalCasRoutes.leaseExisting({ stackId, tenantId, hash }),
      unifiedLease: hash => canonicalCasRoutes.lease({ stackId, tenantId, hash }),
      usage: () => canonicalCasRoutes.usage({ stackId, tenantId }),
      gc: () => canonicalCasRoutes.gc({ stackId, tenantId }),
      rootRefs: () => canonicalCasRoutes.updateRootRefs({ stackId, tenantId }),
    };
  }
  return {
    readContent: hash => legacyCasRoutes.readContent({ tenantId, hash }),
    readMetadata: hash => legacyCasRoutes.readMetadata({ tenantId, hash }),
    leaseNode: hash => legacyCasRoutes.leaseNode({ tenantId, hash }),
    leaseExisting: hash => legacyCasRoutes.leaseExisting({ tenantId, hash }),
    unifiedLease: hash => legacyCasRoutes.leaseExisting({ tenantId, hash }),
    usage: () => legacyCasRoutes.usage({ tenantId }),
    gc: () => legacyCasRoutes.gc({ tenantId }),
    rootRefs: () => legacyCasRoutes.rootRefs({ tenantId }),
  };
}

export interface CasBlobRef {
  readonly hash: string;
  readonly size: number;
  readonly contentType: string;
}

export type CasBlobSource = ReadableStream<Uint8Array> | Blob;

export interface CasBlobWriteOptions {
  readonly contentType: string;
  readonly size?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (uploadedBytes: number) => void;
}

interface BlobTreeNode {
  readonly hash: string;
  readonly size: number;
  /** -1 for a chunk leaf, otherwise the index level. */
  readonly level: number;
}

function isInternalConfig(
  config: CasClientConfig,
): config is Extract<CasClientConfig, { fetcher: HttpFetcher }> {
  return "fetcher" in config;
}

function isCapabilityConfig(
  config: CasClientConfig,
): config is Extract<CasClientConfig, { capability: string }> {
  return "capability" in config;
}

/**
 * CAS HTTP client implementing CasReadContext + upload operations.
 *
 * @deprecated Use `createTenantCasClient` for the canonical tenant API.
 */
export class CasClient implements CasReadContext {
  private config: CasClientConfig;

  constructor(config: CasClientConfig) {
    if (isCapabilityConfig(config)
      && (config.capability.length === 0 || config.sessionId.length === 0)) {
      throw new TypeError("Delegated CAS capability and session ID are required");
    }
    this.config = isInternalConfig(config)
      ? config
      : { ...config, baseUrl: config.baseUrl.replace(/\/$/, "") };
  }

  private origin(): string {
    return isInternalConfig(this.config)
      ? "https://cas.internal"
      : this.config.baseUrl;
  }

  private routes(): ReturnType<typeof tenantRoutesFor> {
    return tenantRoutesFor(this.config);
  }

  private routeUrl(path: string): string {
    return `${this.origin()}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (isCapabilityConfig(this.config)) {
      h.Authorization = `Bearer ${this.config.capability}`;
    } else if (isInternalConfig(this.config)) {
      h["X-Internal-Token"] = this.config.accessKey;
      h["X-Tenant-Id"] = this.config.tenantId;
    } else if (this.config.authToken) {
      h.Authorization = `Bearer ${this.config.authToken}`;
    }
    return h;
  }

  private request(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const headers = this.headers(init.headers ?? {});
    if (isInternalConfig(this.config)) {
      return this.config.fetcher.fetch(url, { ...init, headers });
    }
    return fetch(url, { ...init, headers });
  }

  /** Read CAS node content. */
  async read(ref: CasRef): Promise<Uint8Array> {
    const resp = await this.request(this.routeUrl(this.routes().readContent(ref.hash)));
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "read");
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** Open node own-content without materializing the response body. */
  async openNodeContent(
    hash: string,
    range?: { readonly offset: number; readonly length: number },
  ): Promise<ReadableStream<Uint8Array>> {
    const resp = await this.request(this.routeUrl(this.routes().readContent(hash)), {
      headers: range === undefined
        ? {}
        : { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` },
    });
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "read");
    }
    if (resp.body === null) {
      throw new CasClientError(502, "Missing response body", "read");
    }
    return resp.body;
  }

  /** Store an arbitrarily large blob as a leaf or deterministic chunk tree. */
  async storeBlob(source: CasBlobSource, options: CasBlobWriteOptions): Promise<CasBlobRef> {
    const stream = source instanceof Blob ? source.stream() : source;
    const chunks = chunkSource(stream, options.signal);
    const first = await chunks.next();
    if (first.done) {
      const hash = await this.store(new Uint8Array(0), options.contentType);
      assertExpectedSize(options.size, 0);
      return { hash, size: 0, contentType: options.contentType };
    }

    const second = await chunks.next();
    if (second.done) {
      const hash = await this.store(first.value, options.contentType);
      assertExpectedSize(options.size, first.value.length);
      options.onProgress?.(first.value.length);
      return { hash, size: first.value.length, contentType: options.contentType };
    }

    const groups: BlobTreeNode[][] = [];
    let measuredSize = 0;
    const addChunk = async (bytes: Uint8Array): Promise<void> => {
      const hash = await this.store(bytes, BlobChunkContentType);
      measuredSize += bytes.length;
      options.onProgress?.(measuredSize);
      await this.#appendBlobTreeNode(groups, { hash, size: bytes.length, level: -1 }, options.contentType);
    };

    await addChunk(first.value);
    await addChunk(second.value);
    for await (const bytes of chunks) await addChunk(bytes);

    const root = await this.#finishBlobTree(groups, options.contentType);
    assertExpectedSize(options.size, measuredSize);
    return { hash: root.hash, size: measuredSize, contentType: options.contentType };
  }

  /** Resolve blob metadata without reading its payload. */
  async statBlob(hash: string): Promise<CasBlobRef> {
    const metadata = await this.metadata({ kind: "cas", hash });
    if (metadata.contentType !== BlobIndexContentType) {
      if (metadata.refs.length !== 0) throw new Error(`CAS node ${hash} is not a blob root`);
      return { hash, size: metadata.size, contentType: metadata.contentType };
    }
    const index = decodeBlobIndex(await collectStream(await this.openNodeContent(hash)));
    if (index.children.length !== metadata.refs.length) {
      throw new Error(`Blob index ${hash} child metadata does not match its CAS refs`);
    }
    return { hash, size: index.size, contentType: index.mediaType };
  }

  /** Open a leaf or chunk-tree blob as a backpressure-aware byte stream. */
  async openBlob(ref: CasBlobRef | string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const resolved = typeof ref === "string" ? await this.statBlob(ref) : await this.statBlob(ref.hash);
    if (typeof ref !== "string" && (ref.size !== resolved.size || ref.contentType !== resolved.contentType)) {
      throw new Error(`Blob ref metadata mismatch for ${ref.hash}`);
    }
    const iterator = this.#readBlobNode(resolved.hash, undefined, resolved.contentType, signal);
    return new ReadableStream<Uint8Array>({
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

  /** Open a logical blob byte range without downloading unrelated subtrees. */
  async openBlobRange(
    ref: CasBlobRef | string,
    range: { readonly offset: number; readonly length?: number },
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!Number.isSafeInteger(range.offset) || range.offset < 0) {
      throw new TypeError("Blob range offset must be a non-negative safe integer");
    }
    if (range.length !== undefined && (!Number.isSafeInteger(range.length) || range.length < 0)) {
      throw new TypeError("Blob range length must be a non-negative safe integer");
    }
    const resolved = typeof ref === "string" ? await this.statBlob(ref) : await this.statBlob(ref.hash);
    if (typeof ref !== "string" && (ref.size !== resolved.size || ref.contentType !== resolved.contentType)) {
      throw new Error(`Blob ref metadata mismatch for ${ref.hash}`);
    }
    if (range.offset > resolved.size) throw new RangeError("Blob range offset exceeds blob size");
    const length = Math.min(range.length ?? resolved.size - range.offset, resolved.size - range.offset);
    if (length === 0) return new ReadableStream({ start: controller => controller.close() });

    const iterator = this.#readBlobRangeNode(
      resolved.hash,
      range.offset,
      length,
      undefined,
      resolved.contentType,
      signal,
    );
    return new ReadableStream<Uint8Array>({
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

  async #appendBlobTreeNode(
    groups: BlobTreeNode[][],
    node: BlobTreeNode,
    mediaType: string,
  ): Promise<void> {
    const groupIndex = node.level + 1;
    const group = groups[groupIndex] ??= [];
    group.push(node);
    if (group.length === BlobIndexFanout) {
      groups[groupIndex] = [];
      await this.#appendBlobTreeNode(groups, await this.#storeBlobIndex(group, mediaType), mediaType);
    }
  }

  async #storeBlobIndex(children: readonly BlobTreeNode[], mediaType: string): Promise<BlobTreeNode> {
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
    const refs = children.map(child => child.hash);
    const header = encodeHeader(content.length, BlobIndexContentType, refs.length);
    const hash = hashToHex(await computeNodeDigest(header, BlobIndexContentType, refs.map(hexToHash), content));
    await this.ensureNode(hash, content, BlobIndexContentType, refs);
    return { hash, size, level };
  }

  async #finishBlobTree(groups: BlobTreeNode[][], mediaType: string): Promise<BlobTreeNode> {
    while (true) {
      const populated = groups
        .map((group, index) => ({ group, index }))
        .filter(entry => entry.group.length > 0);
      const count = populated.reduce((total, entry) => total + entry.group.length, 0);
      if (count === 1) return populated[0].group[0];
      const lowest = populated[0];
      groups[lowest.index] = [];
      await this.#appendBlobTreeNode(
        groups,
        await this.#storeBlobIndex(lowest.group, mediaType),
        mediaType,
      );
    }
  }

  async *#readBlobNode(
    hash: string,
    expectedLevel: number | undefined,
    expectedMediaType: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    signal?.throwIfAborted();
    const metadata = await this.metadata({ kind: "cas", hash });
    if (metadata.contentType !== BlobIndexContentType) {
      if (metadata.refs.length !== 0) throw new Error(`CAS node ${hash} is not a blob leaf`);
      if (expectedLevel !== undefined && (expectedLevel !== -1 || metadata.contentType !== BlobChunkContentType)) {
        throw new Error(`Blob tree leaf ${hash} has an invalid type or level`);
      }
      const reader = (await this.openNodeContent(hash)).getReader();
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

    const index = decodeBlobIndex(await collectStream(await this.openNodeContent(hash)));
    if (
      index.mediaType !== expectedMediaType
      || (expectedLevel !== undefined && index.level !== expectedLevel)
      || index.children.length !== metadata.refs.length
    ) {
      throw new Error(`Blob index ${hash} metadata is inconsistent`);
    }
    for (let child = 0; child < metadata.refs.length; child++) {
      yield* this.#readBlobNode(
        metadata.refs[child],
        index.level - 1,
        expectedMediaType,
        signal,
      );
    }
  }

  async *#readBlobRangeNode(
    hash: string,
    offset: number,
    length: number,
    expectedLevel: number | undefined,
    expectedMediaType: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    signal?.throwIfAborted();
    const metadata = await this.metadata({ kind: "cas", hash });
    if (metadata.contentType !== BlobIndexContentType) {
      if (metadata.refs.length !== 0) throw new Error(`CAS node ${hash} is not a blob leaf`);
      if (expectedLevel !== undefined && (expectedLevel !== -1 || metadata.contentType !== BlobChunkContentType)) {
        throw new Error(`Blob tree leaf ${hash} has an invalid type or level`);
      }
      const reader = (await this.openNodeContent(hash, { offset, length })).getReader();
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

    const index = decodeBlobIndex(await collectStream(await this.openNodeContent(hash)));
    if (
      index.mediaType !== expectedMediaType
      || (expectedLevel !== undefined && index.level !== expectedLevel)
      || index.children.length !== metadata.refs.length
    ) {
      throw new Error(`Blob index ${hash} metadata is inconsistent`);
    }

    const end = offset + length;
    let childStart = 0;
    for (let child = 0; child < index.children.length; child++) {
      const childEnd = childStart + index.children[child].size;
      const intersectionStart = Math.max(offset, childStart);
      const intersectionEnd = Math.min(end, childEnd);
      if (intersectionStart < intersectionEnd) {
        yield* this.#readBlobRangeNode(
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
  }

  /**
   * Store content, returning its CAS hash. Satisfies the editor-side
   * `CasReadContext.store` — content-addressed upload via `ensureNode`.
   */
  async store(bytes: Uint8Array, contentType: string): Promise<string> {
    // The CAS service is content-addressed by its canonical node digest —
    // SHA-256(header ‖ contentType ‖ childHashes ‖ content) — and rejects any
    // other hash. A stored blob is a leaf node (no children), so refCount 0.
    const header = encodeHeader(bytes.length, contentType, 0);
    const digest = await computeNodeDigest(header, contentType, [], bytes);
    const hash = hashToHex(digest);
    await this.ensureNode(hash, bytes, contentType);
    return hash;
  }

  /** Read CAS node metadata. */
  async metadata(ref: CasRef): Promise<{ hash: string; size: number; contentType: string; refs: readonly string[] }> {
    const resp = await this.request(this.routeUrl(this.routes().readMetadata(ref.hash)));
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "metadata");
    }
    const body = await resp.json() as { metadata: { hash: string; size: number; contentType: string; refs: string[] } };
    return body.metadata;
  }

  /**
   * Lease a node, uploading content when the node is not already ready.
   *
  * POST /tenants/{tenantId}/cas/nodes/{hash}
   */
  async ensureNode(
    hash: string,
    content: Uint8Array,
    contentType: string,
    refs: string[] = [],
    requestedDurationMs?: number,
  ): Promise<CasLeaseResult> {
    if (stackIdOf(this.config) !== undefined) {
      const childHashes = refs.map(hexToHash);
      const header = encodeHeader(content.length, contentType, childHashes.length);
      const canonical = concatenateNodeBytes(
        header,
        new TextEncoder().encode(contentType),
        childHashes,
        content,
      );
      const canonicalResp = await this.request(this.routeUrl(this.routes().unifiedLease(hash)), {
        method: "POST",
        headers: {
          "Content-Type": CanonicalNodeContentType,
          "Content-Length": String(canonical.length),
          ...(requestedDurationMs == null
            ? {}
            : { "X-CAS-Lease-Duration": String(requestedDurationMs) }),
        },
        body: canonical as BufferSource,
      });
      if (!canonicalResp.ok) {
        throw new CasClientError(canonicalResp.status, canonicalResp.statusText, "lease");
      }
      return canonicalResp.json() as Promise<CasLeaseResult>;
    }

    const extra: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(content.length),
    };
    if (refs.length > 0) extra["X-CAS-Refs"] = refs.join(",");
    if (requestedDurationMs != null) extra["X-CAS-Lease-Duration"] = String(requestedDurationMs);

    const resp = await this.request(this.routeUrl(this.routes().leaseNode(hash)), {
      method: "POST",
      headers: extra,
      body: content as BufferSource,
    });
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "lease");
    }
    return resp.json() as Promise<CasLeaseResult>;
  }

  /**
   * Extend a lease on an existing ready node.
   *
  * POST /tenants/{tenantId}/cas/nodes/{hash}/lease
   */
  async leaseExisting(hash: string, requestedDurationMs?: number): Promise<CasLeaseResult> {
    const extra: Record<string, string> = {};
    if (requestedDurationMs != null) extra["X-CAS-Lease-Duration"] = String(requestedDurationMs);

    const resp = await this.request(this.routeUrl(this.routes().unifiedLease(hash)), {
      method: "POST",
      headers: extra,
    });
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "leaseExisting");
    }
    return resp.json() as Promise<CasLeaseResult>;
  }

  /**
   * Editor-only: increment root-reference counts on the CAS worker.
   *
   * In canonical stack mode (capability + `stackId`) this posts to
   * `/stacks/{stackId}/tenants/{tenantId}/root-refs` and returns the typed
   * `{success, idempotent, revision}` response. Without `stackId` it keeps
   * the legacy tenant-scoped routes; the shared-key mode still uses
   * `/_internal/root-refs`.
   */
  async updateRootRefs(update: CasRootRefUpdate): Promise<CasRootRefsResult> {
    if (!isInternalConfig(this.config)) {
      throw new Error("updateRootRefs is only available in Editor (service-binding) mode");
    }
    const rootRefsPath = isCapabilityConfig(this.config)
      ? this.routes().rootRefs()
      : "/_internal/root-refs";
    const resp = await this.request(this.routeUrl(rootRefsPath), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!resp.ok) {
      throw new CasClientError(resp.status, resp.statusText, "updateRootRefs");
    }
    return resp.json() as Promise<CasRootRefsResult>;
  }
}

/**
 * Aggregate CAS references from a batch of SValue operations by walking
 * branded SBlobs. Returns hash → count map with positive occurrence counts.
 */
export function aggregateRefs(operations: readonly SValue[]): CasReferences {
  return refsFromSValue(operations as SValue);
}

/**
 * Structural view of the lease capability a delta write needs.
 * Satisfied by `CasClient`, and by any cloud-neutral gateway.
 */
export interface CasLeaseGateway {
  leaseNode(hash: string): Promise<unknown>;
}

/**
 * Structural view of the root-reference capability a delta commit needs.
 * Satisfied by `CasClient` (Editor mode), and by any cloud-neutral gateway.
 */
export interface CasRootRefGateway {
  updateRootRefs(update: { requestId: string; changes: CasReferences }): Promise<CasRootRefsResult>;
}

/** Lease every SBlob hash referenced by a delta. Empty maps are a no-op. */
export async function leaseOpRefs(
  operations: readonly SValue[],
  cas: CasLeaseGateway,
): Promise<CasReferences> {
  const refs = aggregateRefs(operations);
  for (const hash of Object.keys(refs)) {
    await cas.leaseNode(hash);
  }
  return refs;
}

/**
 * Persist root-ref increments after a delta insert. On failure, run rollback
 * (typically DELETE the new delta row) and rethrow.
 */
export async function commitRootRefsOrRollback(
  cas: CasRootRefGateway,
  requestId: string,
  changes: CasReferences,
  rollback: () => void | Promise<void>,
): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  try {
    await cas.updateRootRefs({ requestId, changes });
  } catch (err) {
    await rollback();
    throw err;
  }
}

async function* chunkSource(
  source: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  let chunk = new Uint8Array(BlobChunkBytes);
  let used = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      let offset = 0;
      while (offset < next.value.length) {
        const take = Math.min(BlobChunkBytes - used, next.value.length - offset);
        chunk.set(next.value.subarray(offset, offset + take), used);
        used += take;
        offset += take;
        if (used === BlobChunkBytes) {
          yield chunk;
          chunk = new Uint8Array(BlobChunkBytes);
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
