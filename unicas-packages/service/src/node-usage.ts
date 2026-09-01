import type { CasUsage } from "@unicas/tenant-protocol";

export interface NodeUsageScope {
  readonly stackId: string;
  readonly tenantId: string;
}

export interface NodeUsageEntry {
  readonly hash: string;
  readonly contentSize: number;
  readonly leaseExpiresAt: number;
}

/** Semantic persistence boundary for tenant node usage accounting. */
export interface NodeUsageRepository {
  listNodes(scope: NodeUsageScope): Promise<readonly NodeUsageEntry[]>;
  readCanonicalStoredBytes(scope: NodeUsageScope, hash: string): Promise<number | null>;
  readReservedBytes(scope: NodeUsageScope): Promise<number>;
}

/** Aggregate logical, physical, reservation, readiness, and lease usage. */
export async function readNodeUsage(input: {
  readonly repository: NodeUsageRepository;
  readonly scope: NodeUsageScope;
}): Promise<CasUsage> {
  const nodes = await input.repository.listNodes(input.scope);
  let readyContentBytes = 0;
  let readyStoredBytes = 0;
  let notReadyNodeCount = 0;
  let leasedNodeCount = 0;

  for (const node of nodes) {
    readyContentBytes += node.contentSize;
    if (node.leaseExpiresAt > 0) leasedNodeCount += 1;
    const storedBytes = await input.repository.readCanonicalStoredBytes(
      input.scope,
      node.hash,
    );
    if (storedBytes === null) {
      notReadyNodeCount += 1;
    } else {
      readyStoredBytes += storedBytes;
    }
  }

  return {
    nodeCount: nodes.length,
    readyContentBytes,
    readyStoredBytes,
    reservedBytes: await input.repository.readReservedBytes(input.scope),
    notReadyNodeCount,
    leasedNodeCount,
  };
}