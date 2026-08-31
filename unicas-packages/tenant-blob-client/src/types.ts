/**
 * Blob-layer types. The blob layer is the complete tenant-facing CAS client
 * surface for business users: write, read (random access, SBlobHandler-style),
 * and tenant admin (stat/usage/gc). It sits above the 1:1 HTTP node client in
 * `@unicas/tenant-client` and is the only layer a business user needs.
 */

import type {
  CasHash,
  CasNodeRange,
  CasRootRefsResult,
  TenantCasClient,
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
  /** Lease duration applied to every chunk and index node. Defaults to the server policy. */
  readonly leaseDurationMs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (uploadedBytes: number) => void;
}

export interface CasBlobClientOptions {
  /** Node content bytes per blob chunk. Defaults to the protocol value. */
  readonly chunkBytes?: number;
  /** Children per index node. Defaults to the protocol value. */
  readonly indexFanout?: number;
}

/** Positive blob reference counts to retain or release as one business batch. */
export interface CasBlobRetentionUpdate {
  readonly requestId: string;
  readonly references: Readonly<Record<CasHash, number>>;
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
  /** Escape hatch for node-level transport operations and tenant administration. */
  readonly unicasClient: TenantCasClient;
  /**
   * Write a blob, chunking it into CAS nodes behind a blob-index tree.
   * Every written node is automatically leased. Call `retain` after the
   * surrounding business transaction commits to preserve the blob root.
   */
  storeBlob(source: CasBlobSource, options: CasBlobWriteOptions): Promise<CasBlobRef>;
  /** Open a blob by hash, resolving its metadata and random-access read handle. */
  openBlob(hash: CasHash, signal?: AbortSignal): Promise<CasBlobHandle>;
  /** Retain one or more blob roots. Every reference count must be positive. */
  retain(update: CasBlobRetentionUpdate): Promise<CasRootRefsResult>;
  /** Release one or more blob roots. Every reference count must be positive. */
  release(update: CasBlobRetentionUpdate): Promise<CasRootRefsResult>;
}
