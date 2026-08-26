/**
 * MIGRATION-ONLY legacy package. Verbatim snapshot of the pre-stack CAS
 * tenant protocol (tenant-scoped paths, rootAssignments, portable-node HTTP,
 * isPublicCasRoute). Consumed only by the legacy runtime packages
 * (cloudflare-cas, cas-client, gateways) until they migrate to the canonical
 * stack-scoped `@unidocs/protocol-cas` and the retired handlers are removed
 * (Task 9/10). Do not extend this package; it is removed when the rollback
 * window closes.
 */

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

export interface CasRootAssignment {
  readonly owner: string;
  readonly hash: CasHash | null;
}

export interface CasAssignRootsRequest {
  readonly requestId: string;
  readonly assignments: readonly CasRootAssignment[];
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
  updateRootRefs(update: CasRootRefUpdate): Promise<void>;
  assignRoots(update: CasAssignRootsRequest): Promise<void>;
  usage(): Promise<CasUsage>;
  triggerGc(options?: { maxNodes?: number }): Promise<CasGcResult>;
}
