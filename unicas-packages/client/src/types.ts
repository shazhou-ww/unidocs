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