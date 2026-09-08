import { describe, expect, it, vi } from "vitest";
import { commitPlatformEditorSnapshot } from "../src/platform-editor-commit.js";

const operationId = "save-1";
const stateHash = "a".repeat(64);
const pending = { operationId, baseVersion: 1, requestDigest: "b".repeat(64), state: "pending" as const };
const committed = { ...pending, state: "committed" as const, version: 2 };

function setup() {
  const document = {
    beginCommit: vi.fn(async () => pending),
    pendingCommit: vi.fn(async () => ({ candidate: { operationId, baseVersion: 1, stateHash }, receipt: pending })),
    commitRetained: vi.fn(async () => committed),
    commitStatus: vi.fn(async () => ({ operationId, state: "unknown" as const, reason: "not_found" as const })),
  };
  const roots = { retainRoot: vi.fn(async () => undefined) };
  const snapshot = { capture: vi.fn(async () => ({ content: "# 工作副本" })), store: vi.fn(async () => stateHash) };
  return { document, roots, snapshot };
}

describe("platform editor commit", () => {
  it("captures, stores, retains, and commits a previously unknown operation", async () => {
    const context = setup();
    await expect(commitPlatformEditorSnapshot({ ...context, operationId, baseVersion: 1, committedAt: 100 }))
      .resolves.toEqual(committed);
    expect(context.snapshot.store).toHaveBeenCalledWith({ content: "# 工作副本" });
    expect(context.document.beginCommit).toHaveBeenCalledWith({ operationId, baseVersion: 1, stateHash });
    expect(context.document.commitRetained).toHaveBeenCalledOnce();
  });

  it("resumes a pending intent without requiring the ephemeral compute context", async () => {
    const context = setup();
    context.document.commitStatus.mockResolvedValueOnce(pending);
    await expect(commitPlatformEditorSnapshot({ ...context, operationId, baseVersion: 1, committedAt: 200 }))
      .resolves.toEqual(committed);
    expect(context.snapshot.capture).not.toHaveBeenCalled();
    expect(context.snapshot.store).not.toHaveBeenCalled();
    expect(context.roots.retainRoot).toHaveBeenCalledWith({
      requestId: `platform-commit-${pending.requestDigest}-root`, stateHash,
    });
  });

  it("returns a terminal receipt without compute or CAS work", async () => {
    const context = setup();
    context.document.commitStatus.mockResolvedValueOnce(committed);
    await expect(commitPlatformEditorSnapshot({ ...context, operationId, baseVersion: 1, committedAt: 300 }))
      .resolves.toEqual(committed);
    expect(context.snapshot.capture).not.toHaveBeenCalled();
    expect(context.snapshot.store).not.toHaveBeenCalled();
    expect(context.roots.retainRoot).not.toHaveBeenCalled();
  });
});