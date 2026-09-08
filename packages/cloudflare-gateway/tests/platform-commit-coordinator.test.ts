import { describe, expect, it, vi } from "vitest";
import { commitPlatformDocument, createPlatformDocument, resumePlatformCommit } from "../src/platform-commit-coordinator.js";
import type { PlatformCommitCandidate, PlatformCommitReceipt } from "../src/platform-document-do.js";

const candidate: PlatformCommitCandidate = { operationId: "save-1", baseVersion: 1, stateHash: "a".repeat(64) };
const pending: PlatformCommitReceipt = {
  operationId: candidate.operationId, baseVersion: 1, requestDigest: "b".repeat(64), state: "pending",
};
const committed: PlatformCommitReceipt = { ...pending, state: "committed", version: 2 };

function setup() {
  const document = {
    beginCommit: vi.fn(async () => pending),
    pendingCommit: vi.fn(async () => ({ candidate, receipt: pending })),
    commitRetained: vi.fn(async () => committed),
    commitStatus: vi.fn(async () => committed),
  };
  const roots = { retainRoot: vi.fn(async () => undefined) };
  return { document, roots };
}

describe("platform commit coordinator", () => {
  it("retries initial root retention with the creation intent request ID", async () => {
    const identity = { tenantId: "alice", docId: "doc-1", docType: "markdown", ownerActorId: "user-1", schemaVersion: "markdown/1" };
    const creation = { identity, stateHash: "c".repeat(64), requestDigest: "d".repeat(64) };
    const created = { identity, head: { version: 1, stateHash: creation.stateHash, createdAt: 200 } };
    const document = {
      beginCreate: vi.fn(async () => creation),
      createRetained: vi.fn(async () => created),
    };
    const roots = { retainRoot: vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(undefined) };

    await expect(createPlatformDocument(document, roots, identity, creation.stateHash, 100)).rejects.toThrow("response lost");
    expect(document.createRetained).not.toHaveBeenCalled();
    await expect(createPlatformDocument(document, roots, identity, creation.stateHash, 200)).resolves.toEqual(created);
    expect(roots.retainRoot).toHaveBeenCalledTimes(2);
    expect(roots.retainRoot).toHaveBeenNthCalledWith(2, {
      requestId: `platform-create-${creation.requestDigest}-root`, stateHash: creation.stateHash,
    });
  });

  it("keeps the intent pending when retain fails and resumes with the same root request", async () => {
    const { document, roots } = setup();
    roots.retainRoot.mockRejectedValueOnce(new Error("CAS unavailable"));

    await expect(commitPlatformDocument(document, roots, candidate, 100)).rejects.toThrow("CAS unavailable");
    expect(document.commitRetained).not.toHaveBeenCalled();

    await expect(resumePlatformCommit(document, roots, candidate.operationId, 200)).resolves.toEqual(committed);
    expect(roots.retainRoot).toHaveBeenNthCalledWith(1, {
      requestId: `platform-commit-${pending.requestDigest}-root`, stateHash: candidate.stateHash,
    });
    expect(roots.retainRoot).toHaveBeenNthCalledWith(2, {
      requestId: `platform-commit-${pending.requestDigest}-root`, stateHash: candidate.stateHash,
    });
    expect(document.commitRetained).toHaveBeenCalledOnce();
  });

  it("returns an existing terminal receipt without retaining again", async () => {
    const { document, roots } = setup();
    document.beginCommit.mockResolvedValue(committed);

    await expect(commitPlatformDocument(document, roots, candidate, 100)).resolves.toEqual(committed);
    expect(roots.retainRoot).not.toHaveBeenCalled();
    expect(document.pendingCommit).not.toHaveBeenCalled();
  });

  it("uses status instead of inventing a result when no pending intent exists", async () => {
    const { document, roots } = setup();
    document.pendingCommit.mockResolvedValue(null);

    await expect(resumePlatformCommit(document, roots, candidate.operationId, 100)).resolves.toEqual(committed);
    expect(document.commitStatus).toHaveBeenCalledWith(candidate.operationId);
    expect(roots.retainRoot).not.toHaveBeenCalled();
  });
});