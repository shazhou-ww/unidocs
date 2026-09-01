import { describe, expect, test } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { CasAdminErrorCodes } from "@unicas/admin-protocol";
import type { CasOperatorIdentityKey } from "@unicas/admin-protocol";
import {
  ControlPlaneAdminService,
  encodeControlListCursor,
  sha256Hex,
  type ControlAcceptMemberInvitationCommitResult,
  type ControlAcceptMemberInvitationPlan,
  type ControlAuditRecord,
  type ControlCreateIssuerKeyCommitResult,
  type ControlCreateIssuerKeyPlan,
  type ControlCreateMemberInvitationCommitResult,
  type ControlCreateMemberInvitationPlan,
  type ControlCreateStackCommitResult,
  type ControlCreateStackPlan,
  type ControlDeleteIssuerKeyCommitResult,
  type ControlDeleteIssuerKeyPlan,
  type ControlDeleteMemberCommitResult,
  type ControlDeleteMemberPlan,
  type ControlIdempotencyRecord,
  type ControlIdentityPlan,
  type ControlIdentityRecord,
  type ControlInspectOAuthIssuerCommitResult,
  type ControlInspectOAuthIssuerPlan,
  type ControlIssuerKeyRecord,
  type ControlIssuerRecord,
  type ControlOAuthIssuerRecord,
  type ControlMembershipRecord,
  type ControlMemberInvitationRecord,
  type ControlPatchStackCommitResult,
  type ControlPatchStackPlan,
  type ControlPlaneAdminRepository,
  type ControlPlaneCallContext,
  type ControlPossessionChallengeRecord,
  type ControlPutIssuerCommitResult,
  type ControlPutIssuerPlan,
  type ControlStackRecord,
  type OAuthDiscoveryPort,
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

function fixture(options: {
  listDefaultLimit?: number;
  listMaxLimit?: number;
  now?: () => number;
  oauthDiscovery?: OAuthDiscoveryPort;
  generateOAuthInspectionId?: () => string;
} = {}) {
  const repository = new MemoryControlAdminRepository();
  let stackSequence = 0;
  let eventSequence = 0;
  const service = new ControlPlaneAdminService(repository, {
    now: options.now ?? (() => 1_000),
    generateStackId: () => `cas_stack_${String(++stackSequence).padStart(2, "0")}`,
    generateEventId: () => `event-${++eventSequence}`,
    generateInvitationId: () => `invitation-${eventSequence + 1}`,
    generateInvitationToken: () => "t".repeat(32),
    ...options,
  });
  return { repository, service };
}

function expectError(value: unknown, error: string): void {
  expect(value).toMatchObject({ error });
}

function oauthIssuerRecord(stackId: string): ControlOAuthIssuerRecord {
  return {
    stackId,
    issuer: "https://issuer.example/oauth",
    audience: `https://cas.example/stacks/${stackId}`,
    metadataUrl: "https://issuer.example/.well-known/oauth-authorization-server/oauth",
    metadataType: "oauth",
    authorizationEndpoint: "https://issuer.example/oauth/authorize",
    tokenEndpoint: "https://issuer.example/oauth/token",
    jwksUri: "https://issuer.example/oauth/jwks",
    registrationEndpoint: "https://issuer.example/oauth/register",
    scopesSupported: ["cas:read", "cas:write"],
    codeChallengeMethodsSupported: ["S256"],
    status: "active",
    verifiedAt: 900,
    lastRefreshAt: 950,
    lastRefreshError: null,
    jwksDigest: "sha256:test",
    capabilityMaxLifetimeSeconds: 28800,
    revision: 1,
  };
}

async function proof(input: { nonce: string; stackId: string; kid: string }) {
  const pair = await generateKeyPair("ES256");
  const challenge = ["cas-possession-v1", input.nonce, input.stackId, input.kid, "ES256"].join("\n");
  return {
    publicJwk: await exportJWK(pair.publicKey),
    possessionProof: await new CompactSign(new TextEncoder().encode(challenge))
      .setProtectedHeader({ alg: "ES256" }).sign(pair.privateKey),
  };
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

  test("pages members on a stable snapshot and rejects stale cursors", async () => {
    const { repository, service } = fixture({ listDefaultLimit: 2, listMaxLimit: 2 });
    const stack = await service.createStack(context(), { body: { displayName: "Members" } });
    if ("error" in stack) throw new Error(stack.error);
    repository.memberships.push(
      { stackId: stack.stackId, ...bob, displayName: "Bob", emailForDisplay: "bob@example.com" },
      { stackId: stack.stackId, identityIssuer: alice.identityIssuer, subject: "carol", displayName: "Carol", emailForDisplay: null },
    );
    const first = await service.listMembers(context(), { path: { stackId: stack.stackId } });
    if (!("items" in first) || !first.nextCursor) throw new Error("expected member cursor");
    expect(first.items.map((member) => member.subject)).toEqual(["alice", "bob"]);
    expect(await service.listMembers(context(), { path: { stackId: stack.stackId }, query: { cursor: first.nextCursor } }))
      .toMatchObject({ items: [{ subject: "carol" }], nextCursor: null });
    const stale = await service.listMembers(context(), { path: { stackId: stack.stackId }, query: { limit: 1 } });
    if (!("items" in stale) || !stale.nextCursor) throw new Error("expected stale cursor");
    repository.snapshot += 1;
    expectError(
      await service.listMembers(context(), { path: { stackId: stack.stackId }, query: { cursor: stale.nextCursor } }),
      CasAdminErrorCodes.INVALID_CURSOR,
    );
  });

  test("creates idempotent invitations and accepts one time with synchronized metadata", async () => {
    let now = 1_000;
    const { repository, service } = fixture({ now: () => now });
    const stack = await service.createStack(context(), { body: { displayName: "Invite" } });
    if ("error" in stack) throw new Error(stack.error);
    const request = { path: { stackId: stack.stackId }, body: { emailConstraint: " BOB@example.com " } };
    const first = await service.createMemberInvitation(context(), request, { idempotencyKey: "invite-1" });
    expect(await service.createMemberInvitation(context(), request, { idempotencyKey: "invite-1" })).toEqual(first);
    expect(repository.invitations.size).toBe(1);
    expectError(
      await service.createMemberInvitation(context(), { ...request, body: { emailConstraint: "other@example.com" } }, { idempotencyKey: "invite-1" }),
      CasAdminErrorCodes.IDEMPOTENCY_CONFLICT,
    );
    if (!("acceptUrl" in first)) throw new Error("invite failed");
    const token = first.acceptUrl.split("/").pop()!;
    expectError(await service.acceptMemberInvitation({
      ...context(bob, "Bob"),
      profile: { displayName: "Bob", emailForDisplay: "wrong@example.com" },
    }, { path: { token } }), CasAdminErrorCodes.NOT_FOUND);
    expect(await service.acceptMemberInvitation(context(bob, "Bob"), { path: { token } })).toMatchObject({
      stackId: stack.stackId,
      subject: "bob",
      displayName: "Bob",
      emailForDisplay: "bob@example.com",
    });
    expect(repository.identities.get(identityKey(bob))).toMatchObject({ displayName: "Bob", emailForDisplay: "bob@example.com" });
    expectError(await service.acceptMemberInvitation(context(bob, "Bob"), { path: { token } }), CasAdminErrorCodes.NOT_FOUND);

    repository.invitations.clear();
    const expiring = await service.createMemberInvitation(context(bob, "Bob"), { path: { stackId: stack.stackId } });
    if (!("acceptUrl" in expiring)) throw new Error("invite failed");
    now += 25 * 60 * 60 * 1_000;
    expectError(
      await service.acceptMemberInvitation(context({ ...bob, subject: "carol" }, "Carol"), { path: { token: expiring.acceptUrl.split("/").pop()! } }),
      CasAdminErrorCodes.NOT_FOUND,
    );
  });

  test("protects the last member and enforces the stack revision when deleting", async () => {
    const { repository, service } = fixture();
    const stack = await service.createStack(context(), { body: { displayName: "Delete" } });
    if ("error" in stack) throw new Error(stack.error);
    expectError(await service.deleteMember(context(), { path: { stackId: stack.stackId }, query: alice }, { ifMatch: '"1"' }), CasAdminErrorCodes.LAST_MEMBER);
    repository.memberships.push({ stackId: stack.stackId, ...bob, displayName: "Bob", emailForDisplay: null });
    expectError(await service.deleteMember(context(), { path: { stackId: stack.stackId }, query: bob }, { ifMatch: '"9"' }), CasAdminErrorCodes.REVISION_MISMATCH);
    expect(await service.deleteMember(context(), { path: { stackId: stack.stackId }, query: bob }, { ifMatch: '"1"' })).toEqual({ ok: true });
    expect(repository.memberships.some((member) => sameIdentity(member, bob))).toBe(false);
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

  test("reads issuer configuration only for stack members", async () => {
    const { repository, service } = fixture();
    const created = await service.createStack(context(), { body: { displayName: "Issuer" } });
    if ("error" in created) throw new Error(created.error);
    expectError(
      await service.getIssuer(context(), { path: { stackId: created.stackId } }),
      CasAdminErrorCodes.NOT_FOUND,
    );
    expectError(
      await service.getIssuer(context(bob, "Bob"), { path: { stackId: created.stackId } }),
      CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED,
    );
    await service.putIssuer(context(), { path: { stackId: created.stackId }, body: { issuer: "https://issuer.example/a", audience: "cas" } }, {});
    expect(await service.getIssuer(context(), { path: { stackId: created.stackId } }))
      .toEqual({ stackId: created.stackId, issuer: "https://issuer.example/a", audience: "cas", capabilityMaxLifetimeSeconds: 28800, revision: 1 });
  });

  test("reads discovered OAuth issuer state only for stack members", async () => {
    const { repository, service } = fixture();
    const created = await service.createStack(context(), { body: { displayName: "OAuth" } });
    if ("error" in created) throw new Error(created.error);
    expectError(
      await service.getOAuthIssuer(context(), { path: { stackId: created.stackId } }),
      CasAdminErrorCodes.NOT_FOUND,
    );
    repository.oauthIssuers.set(created.stackId, oauthIssuerRecord(created.stackId));
    expectError(
      await service.getOAuthIssuer(context(bob, "Bob"), { path: { stackId: created.stackId } }),
      CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED,
    );
    expect(await service.getOAuthIssuer(context(), { path: { stackId: created.stackId } }))
      .toEqual(oauthIssuerRecord(created.stackId));
  });

  test("inspects OAuth metadata, stores only a challenge hash, and creates pending state", async () => {
    const oauthDiscovery: OAuthDiscoveryPort = {
      inspectIssuer: async ({ issuer }) => ({
        metadata: {
          issuer,
          metadataUrl: "https://issuer.example/.well-known/oauth-authorization-server/oauth",
          metadataType: "oauth",
          authorizationEndpoint: "https://issuer.example/oauth/authorize",
          tokenEndpoint: "https://issuer.example/oauth/token",
          jwksUri: "https://issuer.example/oauth/jwks",
          registrationEndpoint: null,
          scopesSupported: ["cas:read"],
          codeChallengeMethodsSupported: ["S256"],
        },
        metadataDigest: "a".repeat(64),
        jwksDigest: "b".repeat(64),
        keys: [{
          kid: "key-1",
          algorithm: "ES256",
          publicJwk: { kid: "key-1", alg: "ES256", kty: "EC", crv: "P-256", x: "x", y: "y" },
        }],
      }),
    };
    const { repository, service } = fixture({
      now: () => 1_000,
      oauthDiscovery,
      generateOAuthInspectionId: () => "oinsp_test",
    });
    const created = await service.createStack(context(), { body: { displayName: "OAuth" } });
    if ("error" in created) throw new Error(created.error);
    expectError(
      await service.inspectOAuthIssuer(context(bob, "Bob"), {
        path: { stackId: created.stackId },
        body: { issuer: "https://issuer.example/oauth", audience: "cas" },
      }),
      CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED,
    );
    const result = await service.inspectOAuthIssuer(context(), {
      path: { stackId: created.stackId },
      body: { issuer: "https://issuer.example/oauth", audience: "cas" },
    });
    if (!("challenge" in result)) throw new Error("inspection failed");
    expect(result).toMatchObject({
      inspectionId: "oinsp_test",
      stackId: created.stackId,
      expiresAt: 601_000,
      revision: 1,
      keys: [{ kid: "key-1", algorithm: "ES256" }],
    });
    expect(repository.oauthIssuers.get(created.stackId)).toMatchObject({ status: "pending", revision: 1 });
    expect(repository.inspections[0]).toMatchObject({ inspectionId: "oinsp_test", usedAt: null });
    expect(repository.inspections[0]?.challengeHash).toBe(await sha256Hex(result.challenge));
    expect(JSON.stringify(repository.inspections[0])).not.toContain(result.challenge);
    expect(repository.audits.at(-1)?.action).toBe("oauth_issuer.inspection.created");
  });

  test("creates an issuer with default lifetime and rejects global duplicates", async () => {
    const { repository, service } = fixture();
    const a = await service.createStack(context(), { body: { displayName: "A" } });
    const b = await service.createStack(context(), { body: { displayName: "B" } });
    if ("error" in a || "error" in b) throw new Error("stack create failed");
    expect(await service.putIssuer(context(), { path: { stackId: a.stackId }, body: { issuer: "https://issuer.example/a", audience: "cas" } }, {}))
      .toMatchObject({ issuer: "https://issuer.example/a", audience: "cas", capabilityMaxLifetimeSeconds: 28800, revision: 1 });
    expectError(
      await service.putIssuer(context(), { path: { stackId: b.stackId }, body: { issuer: "https://issuer.example/a", audience: "cas" } }, {}),
      CasAdminErrorCodes.ISSUER_CONFLICT,
    );
    expectError(
      await service.putIssuer(context(), { path: { stackId: b.stackId }, body: { issuer: "https://issuer.example/b", audience: "cas" } }, { ifMatch: '"1"' }),
      CasAdminErrorCodes.REVISION_MISMATCH,
    );
    expect(repository.audits.map((event) => event.action)).toEqual([
      "stack.created",
      "stack.created",
      "issuer.put",
    ]);
  });

  test("keeps the issuer immutable and enforces preconditions and lifetime bounds", async () => {
    const { repository, service } = fixture();
    const created = await service.createStack(context(), { body: { displayName: "Issuer" } });
    if ("error" in created) throw new Error(created.error);
    const put = { path: { stackId: created.stackId }, body: { issuer: "https://issuer.example/a", audience: "cas" } };
    expect(await service.putIssuer(context(), put, {})).toMatchObject({ revision: 1 });
    expectError(await service.putIssuer(context(), put, {}), CasAdminErrorCodes.PRECONDITION_REQUIRED);
    expectError(
      await service.putIssuer(context(), { ...put, body: { ...put.body, issuer: "https://issuer.example/other" } }, { ifMatch: '"1"' }),
      CasAdminErrorCodes.INVALID_REQUEST,
    );
    expectError(
      await service.putIssuer(context(), { ...put, body: { ...put.body, capabilityMaxLifetimeSeconds: 5 } }, { ifMatch: '"1"' }),
      CasAdminErrorCodes.INVALID_REQUEST,
    );
    expect(await service.putIssuer(context(), { ...put, body: { ...put.body, audience: "cas-v2", capabilityMaxLifetimeSeconds: 3600 } }, { ifMatch: '"1"' }))
      .toMatchObject({ audience: "cas-v2", capabilityMaxLifetimeSeconds: 3600, revision: 2 });
    expectError(await service.putIssuer(context(), put, { ifMatch: '"1"' }), CasAdminErrorCodes.REVISION_MISMATCH);
    expect(repository.issuers.get(created.stackId)).toMatchObject({ revision: 2 });
  });

  test("mints one-time possession challenges for members of a configured stack", async () => {
    const { repository, service } = fixture();
    const stack = await service.createStack(context(), { body: { displayName: "Keys" } });
    if ("error" in stack) throw new Error(stack.error);
    expectError(
      await service.createPossessionChallenge(context(), { stackId: stack.stackId, kid: "k1", algorithm: "ES256" }),
      CasAdminErrorCodes.NOT_FOUND,
    );
    await service.putIssuer(context(), { path: { stackId: stack.stackId }, body: { issuer: "https://issuer.example/a", audience: "cas" } }, {});
    const challenge = await service.createPossessionChallenge(context(), { stackId: stack.stackId, kid: "k1", algorithm: "ES256" });
    if (!("nonce" in challenge)) throw new Error("challenge failed");
    expect(repository.possessionChallenges.get(challenge.nonce)).toMatchObject({ kid: "k1", algorithm: "ES256" });
    expectError(
      await service.createPossessionChallenge(context(bob, "Bob"), { stackId: stack.stackId, kid: "k1", algorithm: "ES256" }),
      CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED,
    );
    expectError(
      await service.createPossessionChallenge(context(), { stackId: stack.stackId, kid: "bad kid!", algorithm: "ES256" }),
      CasAdminErrorCodes.INVALID_REQUEST,
    );
    expectError(
      await service.createPossessionChallenge(context(), { stackId: stack.stackId, kid: "k1", algorithm: "PS256" }),
      CasAdminErrorCodes.INVALID_REQUEST,
    );
    expect(await service.listIssuerKeys(context(), { path: { stackId: stack.stackId } })).toEqual({ keys: [] });
  });

  test("creates keys only with a verified possession proof and replays idempotency", async () => {
    const { repository, service } = fixture();
    const stack = await service.createStack(context(), { body: { displayName: "Keys" } });
    if ("error" in stack) throw new Error(stack.error);
    await service.putIssuer(context(), { path: { stackId: stack.stackId }, body: { issuer: "https://issuer.example/a", audience: "cas" } }, {});
    const challenge = await service.createPossessionChallenge(context(), { stackId: stack.stackId, kid: "k1", algorithm: "ES256" });
    if (!("nonce" in challenge)) throw new Error("challenge failed");
    const signed = await proof({ nonce: challenge.nonce, stackId: stack.stackId, kid: "k1" });
    const request = { path: { stackId: stack.stackId }, body: { kid: "k1", algorithm: "ES256", ...signed } };
    expectError(
      await service.createIssuerKey(context(), { ...request, body: { ...request.body, publicJwk: await exportJWK((await generateKeyPair("ES256")).publicKey) } }),
      CasAdminErrorCodes.INVALID_REQUEST,
    );
    const created = await service.createIssuerKey(context(), request, { idempotencyKey: "create-key-1" });
    expect(created).toMatchObject({ kid: "k1", state: "active", revision: 1 });
    // The one-time challenge is consumed; even an idempotent retry must mint a
    // fresh challenge (legacy ordering validates the challenge first).
    expectError(
      await service.createIssuerKey(context(), request, { idempotencyKey: "create-key-1" }),
      CasAdminErrorCodes.INVALID_REQUEST,
    );
    expectError(await service.createIssuerKey(context(), request), CasAdminErrorCodes.INVALID_REQUEST);
    // A fresh challenge for an existing kid is rejected before any insert.
    const again = await service.createPossessionChallenge(context(), { stackId: stack.stackId, kid: "k1", algorithm: "ES256" });
    if (!("nonce" in again)) throw new Error("challenge failed");
    const resigned = await proof({ nonce: again.nonce, stackId: stack.stackId, kid: "k1" });
    expectError(
      await service.createIssuerKey(context(), { path: { stackId: stack.stackId }, body: { kid: "k1", algorithm: "ES256", ...resigned } }),
      CasAdminErrorCodes.KEY_STATE_CONFLICT,
    );
    // Reusing the idempotency key with a different valid payload conflicts.
    const other = await service.createPossessionChallenge(context(), { stackId: stack.stackId, kid: "k2", algorithm: "ES256" });
    if (!("nonce" in other)) throw new Error("challenge failed");
    const signed2 = await proof({ nonce: other.nonce, stackId: stack.stackId, kid: "k2" });
    expectError(
      await service.createIssuerKey(context(), { path: { stackId: stack.stackId }, body: { kid: "k2", algorithm: "ES256", ...signed2 } }, { idempotencyKey: "create-key-1" }),
      CasAdminErrorCodes.IDEMPOTENCY_CONFLICT,
    );
    expect(repository.possessionChallenges.has(challenge.nonce)).toBe(false);
    expect(await service.listIssuerKeys(context(), { path: { stackId: stack.stackId } })).toMatchObject({ keys: [{ kid: "k1" }] });
  });

  test("enforces active-key safety and revision preconditions on key transitions", async () => {
    const { repository, service } = fixture();
    const stack = await service.createStack(context(), { body: { displayName: "Keys" } });
    if ("error" in stack) throw new Error(stack.error);
    await service.putIssuer(context(), { path: { stackId: stack.stackId }, body: { issuer: "https://issuer.example/a", audience: "cas" } }, {});
    const first = await service.createPossessionChallenge(context(), { stackId: stack.stackId, kid: "k1", algorithm: "ES256" });
    const second = await service.createPossessionChallenge(context(), { stackId: stack.stackId, kid: "k2", algorithm: "ES256" });
    if (!("nonce" in first) || !("nonce" in second)) throw new Error("challenge failed");
    await service.createIssuerKey(context(), { path: { stackId: stack.stackId }, body: { kid: "k1", algorithm: "ES256", ...await proof({ nonce: first.nonce, stackId: stack.stackId, kid: "k1" }) } });
    expectError(await service.deleteIssuerKey(context(), { path: { stackId: stack.stackId, kid: "k1" } }, { ifMatch: '"1"' }), CasAdminErrorCodes.KEY_STATE_CONFLICT);
    await service.createIssuerKey(context(), { path: { stackId: stack.stackId }, body: { kid: "k2", algorithm: "ES256", ...await proof({ nonce: second.nonce, stackId: stack.stackId, kid: "k2" }) } });
    expectError(await service.deleteIssuerKey(context(), { path: { stackId: stack.stackId, kid: "k1" } }, {}), CasAdminErrorCodes.PRECONDITION_REQUIRED);
    expectError(await service.deleteIssuerKey(context(), { path: { stackId: stack.stackId, kid: "k1" } }, { ifMatch: '"9"' }), CasAdminErrorCodes.REVISION_MISMATCH);
    expectError(await service.deleteIssuerKey(context(), { path: { stackId: stack.stackId, kid: "missing" } }, { ifMatch: '"1"' }), CasAdminErrorCodes.NOT_FOUND);
    expect(await service.deleteIssuerKey(context(), { path: { stackId: stack.stackId, kid: "k1" }, body: { toState: "retiring" } }, { ifMatch: '"1"' }))
      .toMatchObject({ state: "retiring", revision: 2 });
    expect(await service.deleteIssuerKey(context(), { path: { stackId: stack.stackId, kid: "k1" }, body: { toState: "revoked" } }, { ifMatch: '"2"' }))
      .toMatchObject({ state: "revoked", revision: 3 });
    expect(repository.issuerKeys.get(`${stack.stackId}\nk1`)).toMatchObject({ state: "revoked", revision: 3 });
    expect(repository.audits.map((event) => event.action)).toContain("issuer.key.deleted");
  });

  test("pages control audit events with cursor and after binding", async () => {
    const { repository, service } = fixture({ listDefaultLimit: 2, listMaxLimit: 2 });
    const stack = await service.createStack(context(), { body: { displayName: "Audit" } });
    if ("error" in stack) throw new Error(stack.error);
    await service.patchStack(context(), { path: { stackId: stack.stackId }, body: { description: "one" } }, { ifMatch: '"1"' });
    await service.patchStack(context(), { path: { stackId: stack.stackId }, body: { description: "two" } }, { ifMatch: '"2"' });
    const first = await service.listControlAuditEvents(context(), { path: { stackId: stack.stackId } });
    if (!("items" in first) || !first.nextCursor) throw new Error("expected cursor");
    expect(first.items.map((event) => event.action)).toEqual(["stack.created", "stack.patched"]);
    expect(first.items[0]).toMatchObject({
      requestId: "request-1",
      traceId: "trace-1",
      actor: { subject: "alice" },
      caller: { channel: "mcp", oauthClientHandle: "client", toolName: "test" },
    });
    const second = await service.listControlAuditEvents(context(), { path: { stackId: stack.stackId }, query: { cursor: first.nextCursor } });
    expect(second).toMatchObject({ items: [{ action: "stack.patched" }], nextCursor: null });
    expectError(await service.listControlAuditEvents(context(), { path: { stackId: stack.stackId }, query: { limit: 3 } }), CasAdminErrorCodes.INVALID_REQUEST);
    expectError(await service.listControlAuditEvents(context(), { path: { stackId: stack.stackId }, query: { cursor: "invalid" } }), CasAdminErrorCodes.INVALID_CURSOR);
    expectError(
      await service.listControlAuditEvents(context(), { path: { stackId: stack.stackId }, query: { cursor: first.nextCursor, after: "x" } }),
      CasAdminErrorCodes.INVALID_REQUEST,
    );
    expectError(
      await service.listControlAuditEvents(context(), { path: { stackId: stack.stackId }, query: { after: "unknown-event" } }),
      CasAdminErrorCodes.INVALID_REQUEST,
    );
    expectError(
      await service.listControlAuditEvents(context(), { path: { stackId: stack.stackId }, query: { cursor: encodeControlListCursor({ version: 1, snapshot: 3, last: "event-999" }) } }),
      CasAdminErrorCodes.INVALID_CURSOR,
    );
    expectError(
      await service.listControlAuditEvents(context(bob, "Bob"), { path: { stackId: stack.stackId } }),
      CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED,
    );
    const stalePage = await service.listControlAuditEvents(context(), { path: { stackId: stack.stackId }, query: { limit: 1 } });
    if (!("items" in stalePage) || !stalePage.nextCursor) throw new Error("expected stale cursor");
    await service.patchStack(context(), { path: { stackId: stack.stackId }, body: { description: "three" } }, { ifMatch: '"3"' });
    expectError(
      await service.listControlAuditEvents(context(), { path: { stackId: stack.stackId }, query: { cursor: stalePage.nextCursor } }),
      CasAdminErrorCodes.INVALID_CURSOR,
    );
  });
});

class MemoryControlAdminRepository implements ControlPlaneAdminRepository {
  readonly identities = new Map<string, ControlIdentityRecord>();
  readonly stacks = new Map<string, ControlStackRecord>();
  readonly issuers = new Map<string, ControlIssuerRecord>();
  readonly oauthIssuers = new Map<string, ControlOAuthIssuerRecord>();
  readonly inspections: ControlInspectOAuthIssuerPlan["inspection"][] = [];
  readonly issuerKeys = new Map<string, ControlIssuerKeyRecord>();
  readonly possessionChallenges = new Map<string, ControlPossessionChallengeRecord>();
  readonly memberships: ControlMembershipRecord[] = [];
  readonly idempotency = new Map<string, ControlIdempotencyRecord>();
  readonly invitations = new Map<string, ControlMemberInvitationRecord>();
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

  listMembers(input: { readonly stackId: string; readonly afterSubject: string; readonly limit: number }): Promise<readonly ControlMembershipRecord[]> {
    return Promise.resolve(this.memberships
      .filter((member) => member.stackId === input.stackId && member.subject > input.afterSubject)
      .sort((left, right) => left.subject.localeCompare(right.subject))
      .slice(0, input.limit));
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

  getOAuthIssuer(stackId: string): Promise<ControlOAuthIssuerRecord | null> {
    return Promise.resolve(this.oauthIssuers.get(stackId) ?? null);
  }

  hasOAuthIssuerElsewhere(issuer: string, stackId: string): Promise<boolean> {
    return Promise.resolve([...this.oauthIssuers.values()]
      .some((record) => record.issuer === issuer && record.stackId !== stackId));
  }

  commitInspectOAuthIssuer(
    plan: ControlInspectOAuthIssuerPlan,
  ): Promise<ControlInspectOAuthIssuerCommitResult> {
    const existing = this.oauthIssuers.get(plan.issuer.stackId);
    if (existing && existing.revision !== plan.issuer.revision - 1) {
      return Promise.resolve({ kind: "revision-mismatch" });
    }
    if ([...this.oauthIssuers.values()].some((record) =>
      record.issuer === plan.issuer.issuer && record.stackId !== plan.issuer.stackId)) {
      return Promise.resolve({ kind: "issuer-conflict" });
    }
    this.oauthIssuers.set(plan.issuer.stackId, plan.issuer);
    this.inspections.push(plan.inspection);
    this.audits.push(plan.audit);
    this.snapshot += 1;
    return Promise.resolve({ kind: "created" });
  }

  hasMembership(identity: CasOperatorIdentityKey, stackId: string): Promise<boolean> {
    return Promise.resolve(this.memberships.some((member) => member.stackId === stackId && sameIdentity(member, identity)));
  }

  getIdempotency<T = unknown>(input: {
    readonly identity: CasOperatorIdentityKey;
    readonly method: string;
    readonly canonicalRoute: string;
    readonly key: string;
    readonly now: number;
  }): Promise<ControlIdempotencyRecord<T> | null> {
    const record = this.idempotency.get(idempotencyKey(input));
    return Promise.resolve(record && record.expiresAt > input.now ? record as ControlIdempotencyRecord<T> : null);
  }


  getInvitationByTokenHash(tokenHash: string): Promise<ControlMemberInvitationRecord | null> {
    return Promise.resolve([...this.invitations.values()].find((invitation) => invitation.tokenHash === tokenHash) ?? null);
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

  commitCreateMemberInvitation(plan: ControlCreateMemberInvitationPlan): Promise<ControlCreateMemberInvitationCommitResult> {
    if (plan.idempotency) {
      const key = idempotencyKey(plan.idempotency);
      const existing = this.idempotency.get(key);
      if (existing) return Promise.resolve({
        kind: "idempotency-race",
        record: existing as ControlIdempotencyRecord<ControlCreateMemberInvitationPlan["response"]>,
      });
      this.idempotency.set(key, plan.idempotency);
    }
    this.invitations.set(plan.invitation.invitationId, plan.invitation);
    this.audits.push(plan.audit);
    this.snapshot += 1;
    return Promise.resolve({ kind: "created" });
  }

  commitDeleteMember(plan: ControlDeleteMemberPlan): Promise<ControlDeleteMemberCommitResult> {
    const stack = this.stacks.get(plan.stackId);
    if (!stack) return Promise.resolve({ kind: "stack-not-found" });
    if (stack.revision !== plan.expectedRevision) return Promise.resolve({ kind: "revision-mismatch" });
    if (this.memberships.filter((member) => member.stackId === plan.stackId).length <= 1) {
      return Promise.resolve({ kind: "last-member" });
    }
    const index = this.memberships.findIndex((member) => member.stackId === plan.stackId && sameIdentity(member, plan.identity));
    if (index >= 0) this.memberships.splice(index, 1);
    this.audits.push(plan.audit);
    this.snapshot += 1;
    return Promise.resolve({ kind: index >= 0 ? "deleted" : "not-member" });
  }

  commitAcceptMemberInvitation(plan: ControlAcceptMemberInvitationPlan): Promise<ControlAcceptMemberInvitationCommitResult> {
    const invitation = this.invitations.get(plan.invitationId);
    if (!invitation || invitation.tokenHash !== plan.tokenHash || invitation.status !== "pending" || invitation.expiresAt <= plan.now) {
      return Promise.resolve({ kind: "unavailable" });
    }
    this.invitations.set(plan.invitationId, { ...invitation, status: "accepted" });
    this.identities.set(identityKey(plan.identity), plan.identity);
    if (!this.memberships.some((member) => member.stackId === plan.stackId && sameIdentity(member, plan.identity))) {
      this.memberships.push(plan.membership);
    }
    this.audits.push(plan.audit);
    this.snapshot += 1;
    return Promise.resolve({ kind: "accepted" });
  }

  appendAudit(record: ControlAuditRecord): Promise<void> {
    this.audits.push(record);
    return Promise.resolve();
  }

  getIssuer(stackId: string): Promise<ControlIssuerRecord | null> {
    return Promise.resolve(this.issuers.get(stackId) ?? null);
  }

  hasIssuerElsewhere(issuer: string, stackId: string): Promise<boolean> {
    return Promise.resolve([...this.issuers.values()]
      .some((record) => record.issuer === issuer && record.stackId !== stackId));
  }

  commitPutIssuer(plan: ControlPutIssuerPlan): Promise<ControlPutIssuerCommitResult> {
    const existing = this.issuers.get(plan.stackId);
    if (plan.kind === "insert") {
      if (existing || [...this.issuers.values()].some((record) => record.issuer === plan.issuer)) {
        return Promise.resolve({ kind: "issuer-conflict" });
      }
      this.issuers.set(plan.stackId, {
        stackId: plan.stackId,
        issuer: plan.issuer,
        audience: plan.audience,
        capabilityMaxLifetimeSeconds: plan.capabilityMaxLifetimeSeconds,
        revision: plan.nextRevision,
      });
      this.audits.push(plan.audit);
      this.snapshot += 1;
      return Promise.resolve({ kind: "created" });
    }
    if (!existing) return Promise.resolve({ kind: "not-found" });
    if (existing.revision !== plan.expectedRevision) return Promise.resolve({ kind: "revision-mismatch" });
    this.issuers.set(plan.stackId, {
      ...existing,
      audience: plan.audience,
      capabilityMaxLifetimeSeconds: plan.capabilityMaxLifetimeSeconds,
      revision: plan.nextRevision,
    });
    this.audits.push(plan.audit);
    this.snapshot += 1;
    return Promise.resolve({ kind: "updated" });
  }

  createPossessionChallenge(record: ControlPossessionChallengeRecord): Promise<void> {
    this.possessionChallenges.set(record.nonce, record);
    return Promise.resolve();
  }

  getUsablePossessionChallenge(nonce: string): Promise<ControlPossessionChallengeRecord | null> {
    return Promise.resolve(this.possessionChallenges.get(nonce) ?? null);
  }

  listIssuerKeys(stackId: string): Promise<readonly ControlIssuerKeyRecord[]> {
    return Promise.resolve([...this.issuerKeys.values()]
      .filter((key) => key.stackId === stackId)
      .sort((left, right) => left.kid.localeCompare(right.kid)));
  }

  getIssuerKey(stackId: string, kid: string): Promise<ControlIssuerKeyRecord | null> {
    return Promise.resolve(this.issuerKeys.get(`${stackId}\n${kid}`) ?? null);
  }

  hasIssuerKey(stackId: string, kid: string): Promise<boolean> {
    return Promise.resolve(this.issuerKeys.has(`${stackId}\n${kid}`));
  }

  commitCreateIssuerKey(plan: ControlCreateIssuerKeyPlan): Promise<ControlCreateIssuerKeyCommitResult> {
    if (plan.idempotency) {
      const key = idempotencyKey(plan.idempotency);
      const existing = this.idempotency.get(key);
      if (existing) return Promise.resolve({ kind: "idempotency-race", record: existing as ControlIdempotencyRecord<ControlIssuerKeyRecord> });
      this.idempotency.set(key, plan.idempotency);
    }
    if (this.issuerKeys.has(`${plan.key.stackId}\n${plan.key.kid}`)) return Promise.resolve({ kind: "key-exists" });
    if (!this.possessionChallenges.has(plan.challengeNonce)) return Promise.resolve({ kind: "challenge-unavailable" });
    this.issuerKeys.set(`${plan.key.stackId}\n${plan.key.kid}`, plan.key);
    this.possessionChallenges.delete(plan.challengeNonce);
    this.audits.push(plan.audit);
    this.snapshot += 1;
    return Promise.resolve({ kind: "created" });
  }

  commitDeleteIssuerKey(plan: ControlDeleteIssuerKeyPlan): Promise<ControlDeleteIssuerKeyCommitResult> {
    const key = `${plan.stackId}\n${plan.kid}`;
    const current = this.issuerKeys.get(key);
    if (!current) return Promise.resolve({ kind: "not-found" });
    if (current.revision !== plan.expectedRevision) return Promise.resolve({ kind: "revision-mismatch" });
    if (plan.enforceLastActive) {
      const activeCount = [...this.issuerKeys.values()].filter((record) => record.stackId === plan.stackId && record.state === "active").length;
      if (activeCount <= 1) return Promise.resolve({ kind: "last-active" });
    }
    this.issuerKeys.set(key, { ...current, state: plan.toState, revision: plan.nextRevision });
    this.audits.push(plan.audit);
    this.snapshot += 1;
    return Promise.resolve({ kind: "deleted" });
  }

  getAuditEventCreatedAt(stackId: string, eventId: string): Promise<number | null> {
    const record = this.audits.find((event) => event.stackId === stackId && event.eventId === eventId);
    return Promise.resolve(record?.createdAt ?? null);
  }

  listAuditEvents(input: {
    readonly stackId: string;
    readonly afterCreatedAt: number;
    readonly afterEventId: string;
    readonly limit: number;
  }): Promise<readonly ControlAuditRecord[]> {
    return Promise.resolve(this.audits
      .filter((event) => event.stackId === input.stackId
        && (event.createdAt > input.afterCreatedAt || (event.createdAt === input.afterCreatedAt && event.eventId > input.afterEventId)))
      .sort((left, right) => left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId))
      .slice(0, input.limit));
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
