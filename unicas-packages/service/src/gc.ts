import type { CasGcResult } from "@unicas/tenant-protocol";

export const DEFAULT_GC_MAX_NODES = 100;

export interface NodeGcScope {
  readonly stackId: string;
  readonly tenantId: string;
}

export interface NodeGcCandidate {
  readonly hash: string;
}

export interface NodeGcChildReference {
  readonly hash: string;
  readonly count: number;
}

export interface NodeGcDeletion {
  readonly hash: string;
  readonly contentSize: number;
  readonly childReferences: readonly NodeGcChildReference[];
}

/**
 * Semantic persistence boundary for node collection. The caller must hold the
 * keyed single-writer scope for the tenant for the duration of a collection.
 */
export interface NodeGcRepository {
  findExpiredUnreferenced(
    scope: NodeGcScope,
    expiresAtOrBefore: number,
    maxNodes: number,
  ): Promise<readonly NodeGcCandidate[]>;
  readStillExpiredUnreferenced(
    scope: NodeGcScope,
    hash: string,
    expiresAtOrBefore: number,
  ): Promise<NodeGcDeletion | null>;
  deleteCanonicalContent(scope: NodeGcScope, hash: string): Promise<void>;
  commitDeletion(scope: NodeGcScope, deletion: NodeGcDeletion): Promise<void>;
}

/**
 * Collect expired nodes that have no child or root references. Eligibility is
 * re-read immediately before each deletion. Physical content is removed before
 * the atomic metadata/edge commit, matching the existing recovery semantics.
 */
export async function collectExpiredUnreferencedNodes(input: {
  readonly repository: NodeGcRepository;
  readonly scope: NodeGcScope;
  readonly maxNodes?: number;
  readonly now?: () => number;
}): Promise<CasGcResult> {
  const maxNodes = input.maxNodes ?? DEFAULT_GC_MAX_NODES;
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    throw new TypeError("maxNodes must be a positive integer");
  }
  const expiresAtOrBefore = (input.now ?? (() => Date.now()))();
  const candidates = await input.repository.findExpiredUnreferenced(
    input.scope,
    expiresAtOrBefore,
    maxNodes,
  );

  let deleted = 0;
  let reclaimedContentBytes = 0;
  for (const candidate of candidates) {
    const deletion = await input.repository.readStillExpiredUnreferenced(
      input.scope,
      candidate.hash,
      expiresAtOrBefore,
    );
    if (deletion === null) continue;
    await input.repository.deleteCanonicalContent(input.scope, deletion.hash);
    await input.repository.commitDeletion(input.scope, deletion);
    deleted += 1;
    reclaimedContentBytes += deletion.contentSize;
  }

  return {
    examined: candidates.length,
    deleted,
    reclaimedContentBytes,
  };
}
