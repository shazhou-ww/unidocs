import { describe, expect, test } from "vitest";
import {
  collectExpiredUnreferencedNodes,
  DEFAULT_GC_MAX_NODES,
  type NodeGcCandidate,
  type NodeGcDeletion,
  type NodeGcRepository,
  type NodeGcScope,
} from "../src/index.js";

const SCOPE = { stackId: "cas_stack_a", tenantId: "tenant-1" };

class MemoryGcRepository implements NodeGcRepository {
  candidates: NodeGcCandidate[] = [];
  deletions = new Map<string, NodeGcDeletion>();
  operations: string[] = [];
  requestedMaxNodes: number | undefined;
  requestedExpiry: number | undefined;
  failCommit = false;

  async findExpiredUnreferenced(
    _scope: NodeGcScope,
    expiresAtOrBefore: number,
    maxNodes: number,
  ) {
    this.requestedExpiry = expiresAtOrBefore;
    this.requestedMaxNodes = maxNodes;
    return this.candidates.slice(0, maxNodes);
  }

  async readStillExpiredUnreferenced(_scope: NodeGcScope, hash: string) {
    this.operations.push(`read:${hash}`);
    return this.deletions.get(hash) ?? null;
  }

  async deleteCanonicalContent(_scope: NodeGcScope, hash: string) {
    this.operations.push(`content:${hash}`);
  }

  async commitDeletion(_scope: NodeGcScope, deletion: NodeGcDeletion) {
    this.operations.push(`commit:${deletion.hash}`);
    if (this.failCommit) throw new Error("metadata unavailable");
  }
}

describe("node GC service kernel", () => {
  test("uses the default bound and reports examined candidates", async () => {
    const repository = new MemoryGcRepository();
    repository.candidates = [{ hash: "a" }, { hash: "b" }];
    repository.deletions.set("a", { hash: "a", contentSize: 10, childReferences: [] });
    repository.deletions.set("b", { hash: "b", contentSize: 20, childReferences: [] });

    await expect(collectExpiredUnreferencedNodes({
      repository,
      scope: SCOPE,
      now: () => 1234,
    })).resolves.toEqual({ examined: 2, deleted: 2, reclaimedContentBytes: 30 });
    expect(repository.requestedMaxNodes).toBe(DEFAULT_GC_MAX_NODES);
    expect(repository.requestedExpiry).toBe(1234);
  });

  test("rechecks candidates and skips nodes that became referenced", async () => {
    const repository = new MemoryGcRepository();
    repository.candidates = [{ hash: "stale" }, { hash: "eligible" }];
    repository.deletions.set("eligible", {
      hash: "eligible",
      contentSize: 7,
      childReferences: [{ hash: "child", count: 2 }],
    });

    const result = await collectExpiredUnreferencedNodes({
      repository,
      scope: SCOPE,
      maxNodes: 10,
    });
    expect(result).toEqual({ examined: 2, deleted: 1, reclaimedContentBytes: 7 });
    expect(repository.operations).toEqual([
      "read:stale",
      "read:eligible",
      "content:eligible",
      "commit:eligible",
    ]);
    expect(repository.deletions.get("eligible")?.childReferences)
      .toEqual([{ hash: "child", count: 2 }]);
  });

  test("deletes physical content before committing metadata", async () => {
    const repository = new MemoryGcRepository();
    repository.candidates = [{ hash: "a" }];
    repository.deletions.set("a", { hash: "a", contentSize: 1, childReferences: [] });

    await collectExpiredUnreferencedNodes({ repository, scope: SCOPE });
    expect(repository.operations).toEqual(["read:a", "content:a", "commit:a"]);
  });

  test("propagates storage failures without counting a deletion", async () => {
    const repository = new MemoryGcRepository();
    repository.candidates = [{ hash: "a" }];
    repository.deletions.set("a", { hash: "a", contentSize: 1, childReferences: [] });
    repository.failCommit = true;

    await expect(collectExpiredUnreferencedNodes({ repository, scope: SCOPE }))
      .rejects.toThrow("metadata unavailable");
  });

  test("rejects invalid collection bounds", async () => {
    const repository = new MemoryGcRepository();
    for (const maxNodes of [0, -1, 1.5, Number.NaN]) {
      await expect(collectExpiredUnreferencedNodes({ repository, scope: SCOPE, maxNodes }))
        .rejects.toThrow("maxNodes must be a positive integer");
    }
  });
});
