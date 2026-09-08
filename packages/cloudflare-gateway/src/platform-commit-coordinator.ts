import type {
  PlatformCommitCandidate,
  PlatformCommitReceipt,
  PlatformCommitStatus,
  PlatformDocumentCreation,
  PlatformDocumentIdentity,
  PlatformDocumentVersion,
  PlatformPendingCommit,
} from "./platform-document-do.js";

export interface PlatformCreationDocumentPort {
  beginCreate(identity: PlatformDocumentIdentity, initialStateHash: string): Promise<PlatformDocumentCreation>;
  createRetained(identity: PlatformDocumentIdentity, initialStateHash: string, createdAt: number): Promise<{
    readonly identity: PlatformDocumentIdentity;
    readonly head: PlatformDocumentVersion;
  }>;
}

export interface PlatformCommitDocumentPort {
  beginCommit(candidate: PlatformCommitCandidate): Promise<PlatformCommitReceipt>;
  pendingCommit(operationId: string): Promise<PlatformPendingCommit | null>;
  commitRetained(operationId: string, committedAt: number): Promise<PlatformCommitReceipt>;
  commitStatus(operationId: string): Promise<PlatformCommitStatus>;
}

export interface PlatformRootRetentionPort {
  retainRoot(input: { readonly requestId: string; readonly stateHash: string }): Promise<void>;
}

export async function createPlatformDocument(
  document: PlatformCreationDocumentPort,
  roots: PlatformRootRetentionPort,
  identity: PlatformDocumentIdentity,
  initialStateHash: string,
  createdAt: number,
): Promise<{ readonly identity: PlatformDocumentIdentity; readonly head: PlatformDocumentVersion }> {
  const creation = await document.beginCreate(identity, initialStateHash);
  await roots.retainRoot({
    requestId: `platform-create-${creation.requestDigest}-root`,
    stateHash: creation.stateHash,
  });
  return document.createRetained(creation.identity, creation.stateHash, createdAt);
}

export async function commitPlatformDocument(
  document: PlatformCommitDocumentPort,
  roots: PlatformRootRetentionPort,
  candidate: PlatformCommitCandidate,
  committedAt: number,
): Promise<PlatformCommitReceipt> {
  const receipt = await document.beginCommit(candidate);
  if (receipt.state !== "pending") return receipt;
  const resumed = await resumePlatformCommit(document, roots, candidate.operationId, committedAt);
  if (resumed.state === "unknown") throw new Error("Pending platform commit disappeared");
  return resumed;
}

export async function resumePlatformCommit(
  document: PlatformCommitDocumentPort,
  roots: PlatformRootRetentionPort,
  operationId: string,
  committedAt: number,
): Promise<PlatformCommitStatus> {
  const pending = await document.pendingCommit(operationId);
  if (!pending) return document.commitStatus(operationId);
  await roots.retainRoot({
    requestId: `platform-commit-${pending.receipt.requestDigest}-root`,
    stateHash: pending.candidate.stateHash,
  });
  return document.commitRetained(operationId, committedAt);
}