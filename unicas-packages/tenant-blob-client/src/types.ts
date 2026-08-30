/**
 * Blob-layer types. The blob layer is the complete tenant-facing CAS client
 * surface for business users: write, read (random access, SBlobHandler-style),
 * and tenant admin (stat/usage/gc). It sits above the 1:1 HTTP node client in
 * `@unicas/tenant-client` and is the only layer a business user needs.
 */

import type {
  CasGcOptions,
  CasGcResult,
  CasHash,
  CasLeaseOptions,
  CasLeaseResult,
  CasNodeMetadata,
  CasNodeRange,
  CasNodeSource,
  CasRootRefUpdate,
  CasRootRefsResult,
  CasUsage,
} from "@unicas/tenant-client";

/** Blob identity + resolved metadata. */
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
  /** Node content bytes per blob chunk. Defaults to the protocol value. */
  readonly chunkBytes?: number;
  /** Children per index node. Defaults to the protocol value. */
  readonly indexFanout?: number;
}

/** Open read handle for one blob (SBlobHandler-shaped). */
export interface CasBlobHandle {
  readonly ref: CasBlobRef;
  /** Sequential read of the whole blob or a logical byte range. */
  read(range?: CasNodeRange, signal?: AbortSignal): ReadableStream<Uint8Array>;
  /** Materialize one explicitly bounded logical byte range. */
  readBytes(
    range: { readonly offset: number; readonly length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

/** Complete tenant data-plane CAS client surface for business users. */
export interface CasBlobClient {
  /** Write a blob, chunking it into CAS nodes behind a blob-index tree. */
  storeBlob(source: CasBlobSource, options: CasBlobWriteOptions): Promise<CasBlobRef>;
  /** Open a blob by hash for random-access reads. */
  openBlob(hash: CasHash, signal?: AbortSignal): Promise<CasBlobHandle>;
  /** Blob metadata (size/contentType) without reading content. */
  statBlob(hash: CasHash): Promise<CasBlobRef>;
  /** Node metadata (transport passthrough). */
  readMetadata(hash: CasHash, options?: { readonly signal?: AbortSignal }): Promise<CasNodeMetadata>;
  /** Extend a node lease (transport passthrough). */
  leaseNode(
    hash: CasHash,
    source?: CasNodeSource,
    options?: CasLeaseOptions,
  ): Promise<CasLeaseResult>;
  /** Update root references for retention (transport passthrough). */
  updateRootRefs(update: CasRootRefUpdate): Promise<CasRootRefsResult>;
  /** Tenant storage usage. */
  usage(signal?: AbortSignal): Promise<CasUsage>;
  /** Advisory tenant garbage collection. */
  gc(options?: CasGcOptions): Promise<CasGcResult>;
}
