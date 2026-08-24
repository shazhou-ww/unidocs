/**
 * CAS type definitions.
 *
 * Content-addressed storage kernel for UniDocs — pure types, no I/O.
 */

/** 64 lowercase hexadecimal SHA-256 characters. */
export type CasHash = string;

/** Immutable metadata that participates in node identity. */
export interface CasNodeMetadata {
  readonly hash: CasHash;
  /** Byte length of this node's own R2 content. */
  readonly size: number;
  readonly contentType: string;
  /** Ordered child references. Duplicates are significant. */
  readonly refs: readonly CasHash[];
}

/** Mutable lifecycle state (does NOT participate in digest). */
export interface CasNodeState {
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
  readonly childRefCount: number;
  readonly rootRefCount: number;
}

/** Descriptor for creating or leasing a node. */
export interface CasNodeDescriptor {
  readonly hash: CasHash;
  readonly size: number;
  readonly contentType: string;
  readonly refs: readonly CasHash[];
}

/** Result of a lease claim or extension. Successful leases are always ready. */
export interface CasLeaseResult {
  readonly hash: CasHash;
  readonly ready: true;
  readonly leaseStartedAt: number;
  readonly leaseExpiresAt: number;
}

/** Reference counts: hash → positive integer count. */
export type CasReferences = Readonly<Record<CasHash, number>>;

/** Signed reference count deltas: hash → non-zero integer. */
export type CasRefChanges = Readonly<Record<CasHash, number>>;

/** Idempotent root-reference update request. */
export interface CasRootRefUpdate {
  readonly requestId: string;
  readonly changes: CasRefChanges;
}

/** One durable business-root owner assignment. Null releases the owner. */
export interface CasRootAssignment {
  readonly owner: string;
  readonly hash: CasHash | null;
}

/** Idempotent owner-bound root assignment batch. */
export interface CasAssignRootsRequest {
  readonly requestId: string;
  readonly assignments: readonly CasRootAssignment[];
}

/** Storage usage statistics. */
export interface CasUsage {
  readonly nodeCount: number;
  readonly readyContentBytes: number;
  readonly notReadyNodeCount: number;
  readonly leasedNodeCount: number;
}

/** Garbage collection result. */
export interface CasGcResult {
  readonly examined: number;
  readonly deleted: number;
  readonly reclaimedContentBytes: number;
}

/** Service interface for CAS operations (server-side contract). */
export interface UserCasService {
  read(hash: CasHash): Promise<Uint8Array>;
  metadata(hash: CasHash): Promise<CasNodeMetadata>;

  lease(
    descriptor: CasNodeDescriptor,
    requestedDurationMs: number,
    provideContent: () => Promise<Uint8Array>,
  ): Promise<CasLeaseResult>;

  /** Extend a known node's lease; rejects unless ready. */
  leaseExisting(
    hash: CasHash,
    requestedDurationMs: number,
  ): Promise<CasLeaseResult>;

  updateRootRefs(update: CasRootRefUpdate): Promise<void>;

  assignRoots(update: CasAssignRootsRequest): Promise<void>;

  usage(): Promise<CasUsage>;
  triggerGc(options?: { maxNodes?: number }): Promise<CasGcResult>;
}

/** Full node representation (metadata + content). */
export interface CasNode {
  readonly metadata: CasNodeMetadata;
  readonly content: Uint8Array;
}
