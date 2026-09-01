import { describe, expect, test } from "vitest";
import {
  applyRootRefsUpdate,
  canonicalizeRootRefsUpdate,
  parseRootRefsBody,
  RootRefsErrorCodes,
  RootRefsRetryableError,
  RootRefsValidationError,
  withDomainRetry,
  type RootRefCommitPlan,
  type RootRefRepository,
  type RootRefScope,
} from "../src/index.js";

const STACK = "cas_stack_a";
const TENANT = "tenant-1";
const DOMAIN = "doc";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const SCOPE = { stackId: STACK, tenantId: TENANT, refDomain: DOMAIN };

class MemoryRootRefRepository implements RootRefRepository {
  readonly nodes = new Map<string, number>();
  readonly ready = new Set<string>();
  readonly balances = new Map<string, number>();
  readonly requests = new Map<string, { payloadHash: string; revision: number }>();
  revision = 0;
  commits: RootRefCommitPlan[] = [];
  stateReads = 0;
  conflictOnce = false;
  failCommits = 0;
  failRequestLookups = 0;

  async findRequest(_scope: RootRefScope, requestId: string) {
    if (this.failRequestLookups > 0) {
      this.failRequestLookups -= 1;
      throw new Error("lookup unavailable");
    }
    return this.requests.get(requestId) ?? null;
  }

  async readNodes(_scope: Pick<RootRefScope, "stackId" | "tenantId">, hashes: readonly string[]) {
    return hashes.flatMap((hash) => {
      const rootRefCount = this.nodes.get(hash);
      return rootRefCount === undefined ? [] : [{ hash, rootRefCount }];
    });
  }

  async findUnreadyNode(
    _scope: Pick<RootRefScope, "stackId" | "tenantId">,
    hashes: readonly string[],
  ) {
    return hashes.find((hash) => !this.ready.has(hash)) ?? null;
  }

  async readDomainState(_scope: RootRefScope) {
    this.stateReads += 1;
    return { revision: this.revision, balances: new Map(this.balances) };
  }

  async commit(plan: RootRefCommitPlan): Promise<"committed" | "revision-conflict"> {
    if (this.failCommits > 0) {
      this.failCommits -= 1;
      throw new Error("store unavailable");
    }
    if (this.conflictOnce) {
      this.conflictOnce = false;
      return "revision-conflict";
    }
    this.commits.push(plan);
    this.revision = plan.revision;
    for (const [hash, delta] of plan.entries) {
      this.nodes.set(hash, this.nodes.get(hash)! + delta);
    }
    for (const projection of plan.projections) {
      if (projection.refCount === null) this.balances.delete(projection.hash);
      else this.balances.set(projection.hash, projection.refCount);
    }
    this.requests.set(plan.requestId, {
      payloadHash: plan.payloadHash,
      revision: plan.revision,
    });
    return "committed";
  }
}

async function canonical(requestId: string, changes: Record<string, number>) {
  return canonicalizeRootRefsUpdate({ requestId, changes, refDomain: DOMAIN });
}

async function apply(repository: MemoryRootRefRepository, requestId: string, changes: Record<string, number>) {
  return applyRootRefsUpdate({
    repository,
    ...SCOPE,
    canonical: await canonical(requestId, changes),
    now: () => 1234,
  });
}

describe("Root Ref service kernel", () => {
  test("builds and commits one validated transition plan", async () => {
    const repository = new MemoryRootRefRepository();
    repository.nodes.set(H1, 3);
    repository.nodes.set(H2, 1);
    repository.ready.add(H1);

    await expect(apply(repository, "r1", { [H2]: -1, [H1]: 1 }))
      .resolves.toEqual({ idempotent: false, revision: 1 });
    expect(repository.nodes).toEqual(new Map([[H1, 4], [H2, 0]]));
    expect(repository.balances).toEqual(new Map([[H1, 1], [H2, -1]]));
    expect(repository.commits[0]).toMatchObject({
      expectedRevision: 0,
      revision: 1,
      appliedAt: 1234,
      entries: [[H1, 1], [H2, -1]],
    });

    await expect(apply(repository, "r1", { [H1]: 1, [H2]: -1 }))
      .resolves.toEqual({ idempotent: true, revision: 1 });
    expect(repository.commits).toHaveLength(1);
  });

  test("rejects missing, unready, negative, and overflowing node transitions", async () => {
    const repository = new MemoryRootRefRepository();
    repository.nodes.set(H1, 0);

    await expect(apply(repository, "missing", { [H2]: 1 }))
      .rejects.toMatchObject({ code: RootRefsErrorCodes.NODE_NOT_FOUND, status: 404 });
    await expect(apply(repository, "unready", { [H1]: 1 }))
      .rejects.toMatchObject({ code: RootRefsErrorCodes.NODE_NOT_READY, status: 409 });
    await expect(apply(repository, "negative", { [H1]: -1 }))
      .rejects.toMatchObject({ code: RootRefsErrorCodes.NEGATIVE_AGGREGATE, status: 409 });

    repository.nodes.set(H1, Number.MAX_SAFE_INTEGER);
    repository.ready.add(H1);
    await expect(apply(repository, "overflow", { [H1]: 1 }))
      .rejects.toMatchObject({ code: RootRefsErrorCodes.INVALID_REQUEST, status: 400 });
    expect(repository.commits).toHaveLength(0);
  });

  test("checks idempotency before reading mutable node and domain state", async () => {
    const repository = new MemoryRootRefRepository();
    const first = await canonical("r1", { [H1]: 1 });
    repository.requests.set("r1", { payloadHash: first.payloadHash, revision: 7 });

    await expect(applyRootRefsUpdate({ repository, ...SCOPE, canonical: first }))
      .resolves.toEqual({ idempotent: true, revision: 7 });
    expect(repository.stateReads).toBe(0);

    await expect(apply(repository, "r1", { [H1]: 2 }))
      .rejects.toMatchObject({ code: RootRefsErrorCodes.IDEMPOTENCY_CONFLICT, status: 409 });
    expect(repository.stateReads).toBe(0);
  });

  test("turns store failures and revision conflicts into bounded retries", async () => {
    const repository = new MemoryRootRefRepository();
    repository.nodes.set(H1, 1);
    repository.ready.add(H1);
    repository.failRequestLookups = 1;
    repository.conflictOnce = true;
    let attempts = 0;

    const result = await withDomainRetry(async () => {
      attempts += 1;
      return apply(repository, "retry", { [H1]: 1 });
    }, { maxAttempts: 3, jitter: false, sleep: async () => undefined });
    expect(result).toEqual({ idempotent: false, revision: 1 });
    expect(attempts).toBe(3);

    repository.failCommits = 3;
    await expect(withDomainRetry(
      () => apply(repository, "failure", { [H1]: 1 }),
      { maxAttempts: 2, sleep: async () => undefined },
    )).rejects.toBeInstanceOf(RootRefsRetryableError);
  });

  test("parses duplicate-safe JSON and canonicalizes hash order", async () => {
    const duplicate = `{"requestId":"r","changes":{"${H1}":1,"${H1}":2}}`;
    expect(() => parseRootRefsBody(duplicate)).toThrow(RootRefsValidationError);

    const result = await canonical("ordered", { [H2]: -1, [H1]: 1 });
    expect(result.entries).toEqual([[H1, 1], [H2, -1]]);
    expect(result.changesJson).toBe(`{"${H1}":1,"${H2}":-1}`);
    expect(result.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
