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

export interface CasUploadRequiredResult {
  readonly hash: CasHash;
  readonly ready: false;
  readonly status: "upload_required";
  readonly uploadId: string;
  readonly expiresAt: number;
  readonly upload: {
    readonly method: "PUT";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

export type CasLeaseOperationResult = CasLeaseResult | CasUploadRequiredResult;

export type CasReferences = Readonly<Record<CasHash, number>>;
export type CasRefChanges = Readonly<Record<CasHash, number>>;

export interface CasRootRefUpdate {
  readonly requestId: string;
  readonly changes: CasRefChanges;
}

export interface CasUsage {
  readonly nodeCount: number;
  readonly readyContentBytes: number;
  readonly readyStoredBytes: number;
  readonly reservedBytes: number;
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
  readonly content: ReadableStream<Uint8Array>;
}
