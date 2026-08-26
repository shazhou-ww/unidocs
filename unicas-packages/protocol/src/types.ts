import type {
  CasUpdateRootRefsRequest,
  CasUpdateRootRefsResponse,
} from "./http.js";

/** 64 lowercase hexadecimal SHA-256 characters. */
export type CasHash = string;

export interface CasNodeMetadata {
  readonly hash: CasHash;
  readonly size: number;
  readonly contentType: string;
  readonly refs: readonly CasHash[];
}

export interface CasNodeState {
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
  readonly childRefCount: number;
  readonly rootRefCount: number;
}

export interface CasNodeDescriptor {
  readonly hash: CasHash;
  readonly size: number;
  readonly contentType: string;
  readonly refs: readonly CasHash[];
}

export interface CasLeaseResult {
  readonly hash: CasHash;
  readonly ready: true;
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
}

export type CasReferences = Readonly<Record<CasHash, number>>;
export type CasRefChanges = Readonly<Record<CasHash, number>>;

export interface CasRootRefUpdate {
  readonly requestId: string;
  readonly changes: CasRefChanges;
}

export interface CasUsage {
  readonly nodeCount: number;
  readonly readyContentBytes: number;
  readonly notReadyNodeCount: number;
  readonly leasedNodeCount: number;
}

export interface CasGcResult {
  readonly examined: number;
  readonly deleted: number;
  readonly reclaimedContentBytes: number;
}

export interface CasNode {
  readonly metadata: CasNodeMetadata;
  readonly content: Uint8Array;
}

export interface TenantCasService {
  read(hash: CasHash): Promise<Uint8Array>;
  metadata(hash: CasHash): Promise<CasNodeMetadata>;
  lease(
    descriptor: CasNodeDescriptor,
    requestedDurationMs: number,
    provideContent: () => Promise<Uint8Array>,
  ): Promise<CasLeaseResult>;
  leaseExisting(
    hash: CasHash,
    requestedDurationMs: number,
  ): Promise<CasLeaseResult>;
  updateRootRefs(request: CasUpdateRootRefsRequest): Promise<CasUpdateRootRefsResponse>;
  usage(): Promise<CasUsage>;
  triggerGc(options?: { maxNodes?: number }): Promise<CasGcResult>;
}
