import type {
  CasGcResult,
  CasHash,
  CasLeaseResult,
  CasNodeMetadata,
  CasRootRefUpdate,
  CasUsage,
} from "@unicas/protocol";

export interface HttpFetcher {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export type CasHttpFetcher = HttpFetcher;

export interface CasNodeRange {
  readonly offset: number;
  readonly length?: number;
}

export interface CasNodeSource {
  readonly contentLength: number;
  readonly body: ReadableStream<Uint8Array>;
}

export interface CasLeaseOptions {
  readonly durationMs?: number;
  readonly signal?: AbortSignal;
}

export interface CasGcOptions {
  readonly maxNodes?: number;
  readonly signal?: AbortSignal;
}

export interface CasBlobRef {
  readonly hash: CasHash;
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

export interface CasBlobClientOptions {
  /** Node content bytes per blob chunk. Defaults to the protocol maximum. */
  readonly chunkBytes?: number;
}

export interface CasBlobClient {
  storeBlob(source: CasBlobSource, options: CasBlobWriteOptions): Promise<CasBlobRef>;
  statBlob(hash: CasHash): Promise<CasBlobRef>;
  openBlob(ref: CasBlobRef | CasHash, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  openBlobRange(
    ref: CasBlobRef | CasHash,
    range: CasNodeRange,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface CasRootRefsResult {
  readonly success: boolean;
  readonly idempotent?: boolean;
  readonly revision?: number;
}

export interface CasNodeCacheKey {
  readonly stackId: string;
  readonly tenantId: string;
  readonly hash: CasHash;
}

/** Strategy for caching immutable node metadata and own-content reads. */
export interface CasNodeCache {
  metadata(
    key: CasNodeCacheKey,
    load: () => Promise<CasNodeMetadata>,
  ): Promise<CasNodeMetadata>;
  read(
    key: CasNodeCacheKey,
    range: CasNodeRange | undefined,
    load: () => Promise<ReadableStream<Uint8Array>>,
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface CasNodeReader {
  metadata(): Promise<CasNodeMetadata>;
  read(range?: CasNodeRange): Promise<ReadableStream<Uint8Array>>;
}

export interface TenantCasClient {
  node(hash: CasHash): CasNodeReader;
  leaseNode(
    hash: CasHash,
    source?: CasNodeSource,
    options?: CasLeaseOptions,
  ): Promise<CasLeaseResult>;
  updateRootRefs(update: CasRootRefUpdate): Promise<CasRootRefsResult>;
  usage(signal?: AbortSignal): Promise<CasUsage>;
  gc(options?: CasGcOptions): Promise<CasGcResult>;
}

export interface TenantCasClientConfig {
  readonly baseUrl: string;
  readonly stackId: string;
  readonly tenantId: string;
  readonly getToken: () => Promise<string>;
  readonly fetcher?: HttpFetcher;
  readonly cache?: CasNodeCache;
}

export type {
  CasGcResult,
  CasHash,
  CasLeaseResult,
  CasNodeMetadata,
  CasRootRefUpdate,
  CasUsage,
};