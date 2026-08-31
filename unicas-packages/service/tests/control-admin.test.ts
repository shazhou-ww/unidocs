import { describe, expect, test } from "vitest";
import { CasAdminErrorCodes } from "@unicas/admin-protocol";
import type { CasOperatorIdentityKey } from "@unicas/admin-protocol";
import {
  ControlPlaneAdminService,
  type ControlAuditRecord,
  type ControlCreateStackCommitResult,
  type ControlCreateStackPlan,
  type ControlIdempotencyRecord,
  type ControlIdentityPlan,
  type ControlIdentityRecord,
  type ControlMembershipRecord,
  type ControlPatchStackCommitResult,
  type ControlPatchStackPlan,
  type ControlPlaneAdminRepository,
  type ControlPlaneCallContext,
  type ControlStackRecord,
} from "../src/index.js";

const alice: CasOperatorIdentityKey = { identityIssuer: "https://id.example", subject: "alice" };
const bob: CasOperatorIdentityKey = { identityIssuer: "https://id.example", subject: "bob" };

function context(identity = alice, displayName = "Alice"): ControlPlaneCallContext {
  return {
    identity,
    profile: { displayName, emailForDisplay: `${identity.subject}@example.com` },
    requestId: "request-1",
    traceId: "trace-1",
    caller: { channel: "mcp", oauthClientHandle: "client", toolName: "test" },
  };
}

function fixture(options: { listDefaultLimit?: number; listMaxLimit?: number } = {}) {
  const repository = new MemoryControlAdminRepository();
  let stackSequence = 0;
  let eventSequence = 0;
  const service = new ControlPlaneAdminService(repository, {
    now: () => 1_000,
    generateStackId: () => `cas_stack_${String(++stackSequence).padStart(2, "0")}`,
    generateEventId: () => `event-${++eventSequence}`,
    ...options,
  });
  return { repository, service };
}

function expectError(value: unknown, error: string): void {
  expect(value).toMatchObject({ error });
}

describe("ControlPlaneAdminService", () => {
  test("inserts and updates identity display metadata and returns memberships", async () => {
    const { repository, service } = fixture();
    expect(await service.me(context())).toMatchObject({
      identity: { subject: "alice", displayName: "Alice" },
      memberships: [],
    });
    expect(repository.identityPlans.map((plan) => plan.kind)).toEqual(["insert"]);
    expect(repository.audits.map((event) => event.action)).toEqual(["operator.identity.created"]);

    repository.memberships.push({
      stackId: "cas_stack_01",
      ...alice,
      displayName: "Alice",
      emailForDisplay: "alice@example.com",
    });
    expect(await service.me(context(alice, "Alice Updated"))).toMatchObject({
      identity: { displayName: "Alice Updated" },
      memberships: [{ stackId: "cas_stack_01", subject: "alice" }],
    });
    expect(repository.identityPlans.map((plan) => plan.kind)).toEqual(["insert", "update"]);
    expect(repository.audits.map((event) => event.action)).toEqual(["operator.identity.created", "operator.identity.updated"]);
  });

  test("creates owner membership atomically and replays or rejects idempotency keys", async () => {
    const { repository, service } = fixture();
    const first = await service.createStack(context(), { body: { displayName: "  Operations  " } }, { idempotencyKey: "create-1" });
    expect(first).toMatchObject({ stackId: "cas_stack_01", displayName: "Operations", revision: 1 });
    expect(repository.memberships).toContainEqual(expect.objectContaining({ stackId: "cas_stack_01", subject: "alice" }));
    expect(repository.audits).toContainEqual(expect.objectContaining({ action: "stack.created", target: "cas_stack_01" }));

    expect(await service.createStack(context(), { body: { displayName: "  Operations  " } }, { idempotencyKey: "create-1" }))
      .toEqual(first);
    expect(repository.stacks.size).toBe(1);
    expectError(
      await service.createStack(context(), { body: { displayName: "Different" } }, { idempotencyKey: "create-1" }),
      CasAdminErrorCodes.IDEMPOTENCY_CONFLICT,
    );
    expect(repository.stacks.size).toBe(1);
  });

  test("paginates a stable membership-scoped snapshot and enforces list limits", async () => {
    const { repository, service } = fixture({ listDefaultLimit: 2, listMaxLimit: 2 });
    for (const name of ["A", "B", "C"]) await service.createStack(context(), { body: { displayName: name } });
    await service.createStack(context(bob, "Bob"), { body: { displayName: "Hidden" } });

    const first = await service.listStacks(context(), {});
    if (!("items" in first) || !first.nextCursor) throw new Error("expected first page cursor");
    expect(first.items.map((item) => item.displayName)).toEqual(["A", "B"]);
    const second = await service.listStacks(context(), { query: { cursor: first.nextCursor } });
    expect(second).toMatchObject({ items: [{ displayName: "C" }], nextCursor: null });
    expectError(await service.listStacks(context(), { query: { limit: 3 } }), CasAdminErrorCodes.INVALID_REQUEST);
    expectError(await service.listStacks(context(), { query: { cursor: "invalid" } }), CasAdminErrorCodes.INVALID_CURSOR);

    const stalePage = await service.listStacks(context(), { query: { limit: 1 } });
    if (!("items" in stalePage) || !stalePage.nextCursor) throw new Error("expected stale cursor");
    await service.createStack(context(bob, "Bob"), { body: { displayName: "Snapshot change" } });
    expectError(
      await service.listStacks(context(), { query: { cursor: stalePage.nextCursor } }),
      CasAdminErrorCodes.INVALID_CURSOR,
    );
  });

  test("checks membership and stack existence before protocol shaping", async () => {
    const { service } = fixture();
    const created = await service.createStack(context(), { body: { displayName: "Private" } });
    if ("error" in created) throw new Error(created.error);
    expect(await service.getStack(context(), { path: { stackId: created.stackId } })).toEqual(created);
    expectError(
      await service.getStack(context(bob, "Bob"), { path: { stackId: created.stackId } }),
      CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED,
    );
    expectError(
      await service.getStack(context(), { path: { stackId: "cas_missing" } }),
      CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED,
    );
  });

  test("enforces patch preconditions, rejects no-ops, and commits one revision with audit", async () => {
    const { repository, service } = fixture();
    const created = await service.createStack(context(), { body: { displayName: "Stack" } });
    if ("error" in created) throw new Error(created.error);
    expectError(
      await service.patchStack(context(), { path: { stackId: created.stackId }, body: { description: "New" } }, {}),
      CasAdminErrorCodes.PRECONDITION_REQUIRED,
    );
    expectError(
      await service.patchStack(context(), { path: { stackId: created.stackId }, body: { description: "New" } }, { ifMatch: "\"9\"" }),
      CasAdminErrorCodes.REVISION_MISMATCH,
    );
    expectError(
      await service.patchStack(context(), { path: { stackId: created.stackId }, body: { displayName: " Stack " } }, { ifMatch: "\"1\"" }),
      CasAdminErrorCodes.INVALID_REQUEST,
    );
    expect(await service.patchStack(
      context(),
      { path: { stackId: created.stackId }, body: { displayName: "Renamed", description: " New " } },
      { ifMatch: "\"1\"" },
    )).toMatchObject({ displayName: "Renamed", description: "New", revision: 2 });
    expect(repository.patchPlans).toHaveLength(1);
    expect(repository.audits.at(-1)).toMatchObject({ action: "stack.patched", stackId: created.stackId });
  });

  test("records session audit with caller attribution without changing the list snapshot", async () => {
    const { repository, service } = fixture();
    await service.recordSessionAudit(context(), "session.login", "https://id.example:alice");
    expect(repository.snapshot).toBe(0);
    expect(repository.audits).toEqual([
      expect.objectContaining({
        action: "session.login",
        requestId: "request-1",
        traceId: "trace-1",
        callerChannel: "mcp",
        oauthClientHandle: "client",
        toolName: "test",
      }),
    ]);
  });
});

class MemoryControlAdminRepository implements ControlPlaneAdminRepository {
  readonly identities = new Map<string, ControlIdentityRecord>();
  readonly stacks = new Map<string, ControlStackRecord>();
  readonly memberships: ControlMembershipRecord[] = [];
  readonly idempotency = new Map<string, ControlIdempotencyRecord>();
  readonly audits: ControlAuditRecord[] = [];
  readonly identityPlans: ControlIdentityPlan[] = [];
  readonly patchPlans: ControlPatchStackPlan[] = [];
  snapshot = 0;

  getIdentity(identity: CasOperatorIdentityKey): Promise<ControlIdentityRecord | null> {
    return Promise.resolve(this.identities.get(identityKey(identity)) ?? null);
  }

  commitIdentity(plan: ControlIdentityPlan): Promise<void> {
    this.identityPlans.push(plan);
    this.identities.set(identityKey(plan.identity), plan.identity);
    this.audits.push(plan.audit);
    return Promise.resolve();
  }

  listMemberships(identity: CasOperatorIdentityKey): Promise<readonly ControlMembershipRecord[]> {
    return Promise.resolve(this.memberships.filter((member) => sameIdentity(member, identity)));
  }

  readSnapshot(): Promise<number> {
    return Promise.resolve(this.snapshot);
  }

  listStacks(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly afterStackId: string;
    readonly limit: number;
  }): Promise<readonly ControlStackRecord[]> {
    const visible = new Set(this.memberships
      .filter((member) => sameIdentity(member, input.identity))
      .map((member) => member.stackId));
    return Promise.resolve([...this.stacks.values()]
      .filter((stack) => visible.has(stack.stackId) && stack.stackId > input.afterStackId)
      .sort((left, right) => left.stackId.localeCompare(right.stackId))
      .slice(0, input.limit));
  }

  getStack(stackId: string): Promise<ControlStackRecord | null> {
    return Promise.resolve(this.stacks.get(stackId) ?? null);
  }

  hasMembership(identity: CasOperatorIdentityKey, stackId: string): Promise<boolean> {
    return Promise.resolve(this.memberships.some((member) => member.stackId === stackId && sameIdentity(member, identity)));
  }

  getIdempotency(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly method: string;
    readonly canonicalRoute: string;
    readonly key: string;
    readonly now: number;
  }): Promise<ControlIdempotencyRecord | null> {
    const record = this.idempotency.get(idempotencyKey(input));
    return Promise.resolve(record && record.expiresAt > input.now ? record : null);
  }

  commitCreateStack(plan: ControlCreateStackPlan): Promise<ControlCreateStackCommitResult> {
    if (plan.idempotency) {
      const key = idempotencyKey(plan.idempotency);
      const existing = this.idempotency.get(key);
      if (existing) return Promise.resolve({ kind: "idempotency-race", record: existing });
      this.idempotency.set(key, plan.idempotency);
    }
    this.stacks.set(plan.stack.stackId, plan.stack);
    this.memberships.push(plan.membership);
    this.audits.push(plan.audit);
    this.snapshot += 1;
    return Promise.resolve({ kind: "created" });
  }

  commitPatchStack(plan: ControlPatchStackPlan): Promise<ControlPatchStackCommitResult> {
    this.patchPlans.push(plan);
    const current = this.stacks.get(plan.stackId);
    if (!current) return Promise.resolve({ kind: "not-found" });
    if (current.revision !== plan.expectedRevision) return Promise.resolve({ kind: "revision-mismatch" });
    this.stacks.set(plan.stackId, {
      ...current,
      displayName: plan.displayName,
      description: plan.description,
      revision: plan.nextRevision,
    });
    this.audits.push(plan.audit);
    this.snapshot += 1;
    return Promise.resolve({ kind: "updated" });
  }

  appendAudit(record: ControlAuditRecord): Promise<void> {
    this.audits.push(record);
    return Promise.resolve();
  }
}

function identityKey(identity: CasOperatorIdentityKey): string {
  return `${identity.identityIssuer}\n${identity.subject}`;
}

function idempotencyKey(input: {
  readonly identityIssuer: string;
  readonly subject: string;
  readonly method: string;
  readonly canonicalRoute: string;
  readonly key: string;
}): string {
  return `${identityKey(input)}\n${input.method}\n${input.canonicalRoute}\n${input.key}`;
}

function sameIdentity(left: CasOperatorIdentityKey, right: CasOperatorIdentityKey): boolean {
  return left.identityIssuer === right.identityIssuer && left.subject === right.subject;
}
