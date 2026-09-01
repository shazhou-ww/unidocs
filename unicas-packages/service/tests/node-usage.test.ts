import { describe, expect, test } from "vitest";
import {
  readNodeUsage,
  type NodeUsageEntry,
  type NodeUsageRepository,
  type NodeUsageScope,
} from "../src/index.js";

const SCOPE = { stackId: "cas_stack_a", tenantId: "tenant-1" };

class MemoryNodeUsageRepository implements NodeUsageRepository {
  nodes: NodeUsageEntry[] = [];
  storedBytes = new Map<string, number>();
  reservedBytes = 0;
  scopes: NodeUsageScope[] = [];

  async listNodes(scope: NodeUsageScope) {
    this.scopes.push(scope);
    return this.nodes;
  }

  async readCanonicalStoredBytes(scope: NodeUsageScope, hash: string) {
    this.scopes.push(scope);
    return this.storedBytes.get(hash) ?? null;
  }

  async readReservedBytes(scope: NodeUsageScope) {
    this.scopes.push(scope);
    return this.reservedBytes;
  }
}

describe("node usage service kernel", () => {
  test("returns zero usage for an empty tenant", async () => {
    const repository = new MemoryNodeUsageRepository();

    await expect(readNodeUsage({ repository, scope: SCOPE })).resolves.toEqual({
      nodeCount: 0,
      readyContentBytes: 0,
      readyStoredBytes: 0,
      reservedBytes: 0,
      notReadyNodeCount: 0,
      leasedNodeCount: 0,
    });
  });

  test("aggregates logical, physical, reservation, readiness, and lease usage", async () => {
    const repository = new MemoryNodeUsageRepository();
    repository.nodes = [
      { hash: "ready", contentSize: 10, leaseExpiresAt: 20 },
      { hash: "not-ready", contentSize: 7, leaseExpiresAt: 0 },
      { hash: "expired", contentSize: 3, leaseExpiresAt: 1 },
    ];
    repository.storedBytes.set("ready", 42);
    repository.storedBytes.set("expired", 9);
    repository.reservedBytes = 15;

    await expect(readNodeUsage({ repository, scope: SCOPE })).resolves.toEqual({
      nodeCount: 3,
      readyContentBytes: 20,
      readyStoredBytes: 51,
      reservedBytes: 15,
      notReadyNodeCount: 1,
      leasedNodeCount: 2,
    });
    expect(repository.scopes).toEqual([SCOPE, SCOPE, SCOPE, SCOPE, SCOPE]);
  });
});