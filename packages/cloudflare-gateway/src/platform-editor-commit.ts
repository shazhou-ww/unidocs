import type { SValue } from "@unidocs/protocol";
import {
  commitPlatformDocument,
  resumePlatformCommit,
  type PlatformCommitDocumentPort,
  type PlatformRootRetentionPort,
} from "./platform-commit-coordinator.js";
import type { PlatformCommitReceipt, PlatformCommitStatus } from "./platform-document-do.js";

export interface PlatformEditorSnapshotPort {
  capture(): Promise<SValue>;
  store(snapshot: SValue): Promise<string>;
}

export async function commitPlatformEditorSnapshot(input: {
  readonly document: PlatformCommitDocumentPort;
  readonly roots: PlatformRootRetentionPort;
  readonly snapshot: PlatformEditorSnapshotPort;
  readonly operationId: string;
  readonly baseVersion: number;
  readonly committedAt: number;
}): Promise<PlatformCommitStatus> {
  const status = await input.document.commitStatus(input.operationId);
  if (status.state === "pending") {
    return resumePlatformCommit(input.document, input.roots, input.operationId, input.committedAt);
  }
  if (status.state !== "unknown") return status;
  const state = await input.snapshot.capture();
  const stateHash = await input.snapshot.store(state);
  return commitPlatformDocument(input.document, input.roots, {
    operationId: input.operationId,
    baseVersion: input.baseVersion,
    stateHash,
  }, input.committedAt) as Promise<PlatformCommitReceipt>;
}