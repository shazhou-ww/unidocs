import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { CasAdminErrorCodes } from "@unicas/admin-protocol";
import type { CasAdminErrorResponse, CasOperatorIdentityKey } from "@unicas/admin-protocol";
import {
  ControlAuditActions,
  type ControlPlaneCallContext,
  type ControlPlaneOperations,
  type OAuthDiscoveryPort,
} from "@unicas/service";
import { migrateControlSchema } from "../src/control-schema.js";
import { createControlPlaneOperations } from "../src/control-operations.js";
import { ControlSessionStore } from "../src/control-sessions.js";

let miniflare: Miniflare | undefined;
afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
});

async function createService(
  now?: () => number,
  oauthDiscovery?: OAuthDiscoveryPort,
): Promise<{ db: D1Database; service: ControlPlaneOperations }> {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "control-plane-service-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "control-plane-service-test-db" },
    }]
  }));
  await miniflare.ready;
  const db = await miniflare.getD1Database("DB", "control-plane-service-test");
  await migrateControlSchema(db);
  return {
    db,
    service: createControlPlaneOperations(db, {
      now,
      oauthDiscovery,
      oauthResourcePublicOrigin: "https://cas.example",
    }),
  };
}

const ISSUER = "https://accounts.google.com";
const alice: CasOperatorIdentityKey = { identityIssuer: ISSUER, subject: "alice-sub" };
const bob: CasOperatorIdentityKey = { identityIssuer: ISSUER, subject: "bob-sub" };
function ctx(identity: CasOperatorIdentityKey, email = `${identity.subject}@example.com`): ControlPlaneCallContext {
  return { identity, profile: { displayName: identity.subject, emailForDisplay: email }, requestId: "req-1", traceId: "trace-1" };
}
function expectError(value: unknown, error: CasAdminErrorResponse["error"]): void {
  expect(value).toMatchObject({ error });
}
async function createStack(service: ControlPlaneOperations, identity = alice, displayName = "Stack"): Promise<string> {
  const response = await service.createStack(ctx(identity), { body: { displayName } });
  if ("error" in response) throw new Error(response.error);
  return response.stackId;
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

describe("D1-backed control-plane service", () => {
  test("manages identities, stack visibility, metadata revisions, and membership authorization", async () => {
    const { service } = await createService();
    expect(await service.me(ctx(alice))).toMatchObject({ memberships: [], identity: { subject: "alice-sub" } });
    expect(await service.me(ctx(alice, "new@example.com"))).toMatchObject({ identity: { emailForDisplay: "new@example.com" } });
    const stackId = await createStack(service, alice, "Alice Stack");
    expect(await service.listStacks(ctx(alice), {})).toMatchObject({ items: [{ stackId, displayName: "Alice Stack", description: "", revision: 1 }] });
    expect(await service.listStacks(ctx(bob), {})).toMatchObject({ items: [] });
    expectError(await service.getStack(ctx(bob), { path: { stackId } }), CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED);
    expectError(await service.patchStack(ctx(alice), { path: { stackId }, body: { displayName: "Renamed" } }, {}), CasAdminErrorCodes.PRECONDITION_REQUIRED);
    expectError(await service.patchStack(ctx(alice), { path: { stackId }, body: { displayName: "Renamed" } }, { ifMatch: '"99"' }), CasAdminErrorCodes.REVISION_MISMATCH);
    expect(await service.patchStack(ctx(alice), { path: { stackId }, body: { displayName: "Renamed", description: "Production" } }, { ifMatch: '"1"' }))
      .toMatchObject({ displayName: "Renamed", description: "Production", revision: 2 });
  }, 10_000);

  test("enforces invitation constraints, expiry, one-time use, and last-member transfer", async () => {
    let clock = 1_000_000;
    const { service } = await createService(() => clock);
    const stackId = await createStack(service);
    expectError(await service.deleteMember(ctx(alice), { path: { stackId }, query: alice }, { ifMatch: '"1"' }), CasAdminErrorCodes.LAST_MEMBER);
    const invitationRequest = { path: { stackId }, body: { emailConstraint: " BOB-SUB@example.com " } };
    const invitation = await service.createMemberInvitation(ctx(alice), invitationRequest, { idempotencyKey: "invite-bob-1" });
    expect(await service.createMemberInvitation(ctx(alice), invitationRequest, { idempotencyKey: "invite-bob-1" })).toEqual(invitation);
    expectError(
      await service.createMemberInvitation(ctx(alice), { path: { stackId }, body: { emailConstraint: "other@example.com" } }, { idempotencyKey: "invite-bob-1" }),
      CasAdminErrorCodes.IDEMPOTENCY_CONFLICT,
    );
    if (!("invitation" in invitation)) throw new Error("invite failed");
    const token = invitation.acceptUrl.split("/").pop()!;
    expectError(await service.acceptMemberInvitation(ctx(bob, "wrong@example.com"), { path: { token } }), CasAdminErrorCodes.NOT_FOUND);
    expect(await service.acceptMemberInvitation(ctx(bob), { path: { token } })).toMatchObject({ stackId, subject: "bob-sub" });
    expectError(await service.acceptMemberInvitation(ctx(bob), { path: { token } }), CasAdminErrorCodes.NOT_FOUND);
    expect(await service.listMembers(ctx(alice), { path: { stackId }, query: { limit: 1 } })).toMatchObject({
      items: [{ subject: "alice-sub", displayName: null, emailForDisplay: null }],
      nextCursor: expect.any(String),
    });
    const members = await service.listMembers(ctx(alice), { path: { stackId }, query: { limit: 10 } });
    expect(members).toMatchObject({
      items: [
        { subject: "alice-sub" },
        { subject: "bob-sub", displayName: "bob-sub", emailForDisplay: "bob-sub@example.com" },
      ],
    });
    await service.patchStack(ctx(alice), { path: { stackId }, body: { description: "revision two" } }, { ifMatch: '"1"' });
    expectError(await service.deleteMember(ctx(alice), { path: { stackId }, query: alice }, { ifMatch: '"1"' }), CasAdminErrorCodes.REVISION_MISMATCH);
    expect(await service.deleteMember(ctx(alice), { path: { stackId }, query: alice }, { ifMatch: '"2"' })).toEqual({ ok: true });

    const expiring = await service.createMemberInvitation(ctx(bob), { path: { stackId } });
    if (!("invitation" in expiring)) throw new Error("invite failed");
    clock += 25 * 60 * 60 * 1000;
    expectError(await service.acceptMemberInvitation(ctx(alice), { path: { token: expiring.acceptUrl.split("/").pop()! } }), CasAdminErrorCodes.NOT_FOUND);
  });

  test("atomically lets exactly one concurrent claimant consume a pending invitation", async () => {
    const { db, service } = await createService(() => 5_000);
    const stackId = await createStack(service);
    const invitation = await service.createMemberInvitation(ctx(alice), { path: { stackId } });
    if (!("acceptUrl" in invitation)) throw new Error("invite failed");
    const token = invitation.acceptUrl.split("/").pop()!;
    const [left, right] = await Promise.all([
      service.acceptMemberInvitation(ctx(bob), { path: { token } }),
      service.acceptMemberInvitation(ctx(bob), { path: { token } }),
    ]);
    expect([left, right].filter((result) => "stackId" in result)).toHaveLength(1);
    expect([left, right].filter((result) => "error" in result)).toEqual([
      expect.objectContaining({ error: CasAdminErrorCodes.NOT_FOUND }),
    ]);
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM cas_stack_members WHERE stack_id = ? AND identity_issuer = ? AND subject = ?",
    ).bind(stackId, bob.identityIssuer, bob.subject).first()).toEqual({ count: 1 });
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM cas_control_audit_events WHERE stack_id = ? AND action = 'member.invitation.accepted'",
    ).bind(stackId).first()).toEqual({ count: 1 });
  });

  test("enforces issuer uniqueness, immutability, preconditions, and capability lifetime bounds", async () => {
    const { service } = await createService();
    const a = await createStack(service, alice, "A");
    const b = await createStack(service, alice, "B");
    expect(await service.putIssuer(ctx(alice), { path: { stackId: a }, body: { issuer: "https://issuer.example/a", audience: "cas" } }, {}))
      .toMatchObject({ capabilityMaxLifetimeSeconds: 28800, revision: 1 });
    expectError(await service.putIssuer(ctx(alice), { path: { stackId: b }, body: { issuer: "https://issuer.example/a", audience: "cas" } }, {}), CasAdminErrorCodes.ISSUER_CONFLICT);
    expectError(await service.putIssuer(ctx(alice), { path: { stackId: a }, body: { issuer: "https://issuer.example/other", audience: "cas" } }, { ifMatch: '"1"' }), CasAdminErrorCodes.INVALID_REQUEST);
    expect(await service.putIssuer(ctx(alice), { path: { stackId: a }, body: { issuer: "https://issuer.example/a", audience: "cas-v2", capabilityMaxLifetimeSeconds: 3600 } }, { ifMatch: '"1"' }))
      .toMatchObject({ audience: "cas-v2", capabilityMaxLifetimeSeconds: 3600, revision: 2 });
    expectError(await service.putIssuer(ctx(alice), { path: { stackId: a }, body: { issuer: "https://issuer.example/a", audience: "cas", capabilityMaxLifetimeSeconds: 5 } }, { ifMatch: '"2"' }), CasAdminErrorCodes.INVALID_REQUEST);
  });

  test("reads persisted OAuth issuer state only for Stack members", async () => {
    const { db, service } = await createService();
    const stackId = await createStack(service);
    await db.prepare(
      "INSERT INTO cas_stack_oauth_issuers (stack_id, issuer, audience, metadata_url, metadata_type, authorization_endpoint, token_endpoint, jwks_uri, registration_endpoint, scopes_supported, code_challenge_methods_supported, status, verified_at, last_refresh_at, last_refresh_error, jwks_digest, capability_max_lifetime_seconds, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      stackId,
      "https://issuer.example/oauth",
      `https://cas.example/stacks/${stackId}`,
      "https://issuer.example/.well-known/oauth-authorization-server/oauth",
      "oauth",
      "https://issuer.example/oauth/authorize",
      "https://issuer.example/oauth/token",
      "https://issuer.example/oauth/jwks",
      "https://issuer.example/oauth/register",
      JSON.stringify(["cas:read", "cas:write"]),
      JSON.stringify(["S256"]),
      "active",
      100,
      110,
      null,
      "sha256:test",
      28800,
      3,
    ).run();
    expectError(
      await service.getOAuthIssuer(ctx(bob), { path: { stackId } }),
      CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED,
    );
    expect(await service.getOAuthIssuer(ctx(alice), { path: { stackId } })).toMatchObject({
      stackId,
      metadataType: "oauth",
      status: "active",
      scopesSupported: ["cas:read", "cas:write"],
      codeChallengeMethodsSupported: ["S256"],
      revision: 3,
    });
  });

  test("atomically persists an OAuth issuer inspection snapshot", async () => {
    const pair = await generateKeyPair("ES256");
    const publicJwk = { ...await exportJWK(pair.publicKey), kid: "key-1", alg: "ES256" };
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
          publicJwk,
        }],
      }),
    };
    const { db, service } = await createService(() => 1_000, oauthDiscovery);
    const stackId = await createStack(service);
    const result = await service.inspectOAuthIssuer(ctx(alice), {
      path: { stackId },
      body: { issuer: "https://issuer.example/oauth" },
    });
    if (!("challenge" in result)) throw new Error("inspection failed");
    expect(await service.getOAuthIssuer(ctx(alice), { path: { stackId } })).toMatchObject({
      status: "pending",
      audience: `https://cas.example/stacks/${stackId}`,
      capabilityMaxLifetimeSeconds: 1800,
      jwksDigest: "b".repeat(64),
      revision: 1,
    });
    const inspection = await db.prepare(
      "SELECT challenge_hash, expires_at, used_at FROM cas_oauth_issuer_inspections WHERE inspection_id = ?",
    ).bind(result.inspectionId).first();
    expect(inspection).toMatchObject({
      challenge_hash: await import("@unicas/service").then(({ sha256Hex }) => sha256Hex(result.challenge)),
      expires_at: 601_000,
      used_at: null,
    });
    expect(await db.prepare(
      "SELECT kid, algorithm FROM cas_oauth_issuer_inspection_keys WHERE inspection_id = ?",
    ).bind(result.inspectionId).first()).toEqual({ kid: "key-1", algorithm: "ES256" });
    expect(await db.prepare(
      "SELECT action FROM cas_control_audit_events WHERE stack_id = ? AND action = 'oauth_issuer.inspection.created'",
    ).bind(stackId).first()).toEqual({ action: "oauth_issuer.inspection.created" });
    const activationProof = await new CompactSign(new TextEncoder().encode(result.challenge))
      .setProtectedHeader({ alg: "ES256", kid: "key-1" })
      .sign(pair.privateKey);
    expect(await service.activateOAuthIssuer(ctx(alice), {
      path: { stackId },
      body: { inspectionId: result.inspectionId, activationProof },
    }, { ifMatch: '"1"' })).toMatchObject({ status: "active", revision: 2, verifiedAt: 1_000 });
    expect(await db.prepare(
      "SELECT used_at FROM cas_oauth_issuer_inspections WHERE inspection_id = ?",
    ).bind(result.inspectionId).first()).toEqual({ used_at: 1_000 });
    expect(await db.prepare(
      "SELECT kid, algorithm FROM cas_stack_oauth_issuer_keys WHERE stack_id = ?",
    ).bind(stackId).first()).toEqual({ kid: "key-1", algorithm: "ES256" });
    expect(await db.prepare(
      "SELECT action FROM cas_control_audit_events WHERE stack_id = ? AND action = 'oauth_issuer.activated'",
    ).bind(stackId).first()).toEqual({ action: "oauth_issuer.activated" });
    expectError(await service.activateOAuthIssuer(ctx(alice), {
      path: { stackId },
      body: { inspectionId: result.inspectionId, activationProof },
    }, { ifMatch: '"2"' }), CasAdminErrorCodes.NOT_FOUND);
  });

  test("enforces issuer ownership across legacy and OAuth registries", async () => {
    const oauthDiscovery: OAuthDiscoveryPort = {
      inspectIssuer: async ({ issuer }) => ({
        metadata: {
          issuer,
          metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
          metadataType: "oauth",
          authorizationEndpoint: `${issuer}/authorize`,
          tokenEndpoint: `${issuer}/token`,
          jwksUri: `${issuer}/jwks`,
          registrationEndpoint: null,
          scopesSupported: [],
          codeChallengeMethodsSupported: ["S256"],
        },
        metadataDigest: "a".repeat(64),
        jwksDigest: "b".repeat(64),
        keys: [{ kid: "key-1", algorithm: "ES256", publicJwk: { kid: "key-1", alg: "ES256", kty: "EC", crv: "P-256", x: "x", y: "y" } }],
      }),
    };
    const { service } = await createService(() => 1_000, oauthDiscovery);
    const legacyStack = await createStack(service, alice, "Legacy");
    const oauthStack = await createStack(service, alice, "OAuth");
    await service.putIssuer(ctx(alice), {
      path: { stackId: legacyStack },
      body: { issuer: "https://shared.example", audience: "cas" },
    }, {});
    expectError(await service.inspectOAuthIssuer(ctx(alice), {
      path: { stackId: oauthStack },
      body: { issuer: "https://shared.example" },
    }), CasAdminErrorCodes.ISSUER_CONFLICT);
    await service.inspectOAuthIssuer(ctx(alice), {
      path: { stackId: oauthStack },
      body: { issuer: "https://oauth.example" },
    });
    const thirdStack = await createStack(service, alice, "Third");
    expectError(await service.putIssuer(ctx(alice), {
      path: { stackId: thirdStack },
      body: { issuer: "https://oauth.example", audience: "cas" },
    }, {}), CasAdminErrorCodes.ISSUER_CONFLICT);
  });

  test("maps concurrent first OAuth issuer inspections to a revision mismatch", async () => {
    let inspectionCount = 0;
    let releaseInspections: (() => void) | undefined;
    const inspectionsReady = new Promise<void>((resolve) => {
      releaseInspections = resolve;
    });
    const oauthDiscovery: OAuthDiscoveryPort = {
      inspectIssuer: async ({ issuer }) => {
        inspectionCount += 1;
        if (inspectionCount === 2) releaseInspections?.();
        await inspectionsReady;
        return {
          metadata: {
            issuer,
            metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
            metadataType: "oauth",
            authorizationEndpoint: `${issuer}/authorize`,
            tokenEndpoint: `${issuer}/token`,
            jwksUri: `${issuer}/jwks`,
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
        };
      },
    };
    const { service } = await createService(() => 1_000, oauthDiscovery);
    const stackId = await createStack(service);
    const request = {
      path: { stackId },
      body: { issuer: "https://issuer.example/oauth" },
    };

    const results = await Promise.all([
      service.inspectOAuthIssuer(ctx(alice), request),
      service.inspectOAuthIssuer(ctx(alice), request),
    ]);

    expect(results.filter((result) => "challenge" in result)).toHaveLength(1);
    expect(results.filter((result) => "error" in result)).toEqual([
      expect.objectContaining({ error: CasAdminErrorCodes.REVISION_MISMATCH }),
    ]);
  }, 10_000);

  test("requires possession proof and safe issuer-key lifecycle transitions", async () => {
    const { service } = await createService();
    const stackId = await createStack(service);
    await service.putIssuer(ctx(alice), { path: { stackId }, body: { issuer: "https://issuer.example/a", audience: "cas" } }, {});
    const challenge = await service.createPossessionChallenge(ctx(alice), { stackId, kid: "k1", algorithm: "ES256" });
    if (!("nonce" in challenge)) throw new Error("challenge failed");
    const signed = await proof({ nonce: challenge.nonce, stackId, kid: "k1" });
    const other = await generateKeyPair("ES256");
    expectError(await service.createIssuerKey(ctx(alice), { path: { stackId }, body: { kid: "k1", algorithm: "ES256", publicJwk: await exportJWK(other.publicKey), possessionProof: signed.possessionProof } }), CasAdminErrorCodes.INVALID_REQUEST);
    expect(await service.createIssuerKey(ctx(alice), { path: { stackId }, body: { kid: "k1", algorithm: "ES256", ...signed } })).toMatchObject({ kid: "k1", state: "active" });
    expectError(await service.deleteIssuerKey(ctx(alice), { path: { stackId, kid: "k1" } }, { ifMatch: '"1"' }), CasAdminErrorCodes.KEY_STATE_CONFLICT);
    const c2 = await service.createPossessionChallenge(ctx(alice), { stackId, kid: "k2", algorithm: "ES256" });
    if (!("nonce" in c2)) throw new Error("challenge failed");
    const signed2 = await proof({ nonce: c2.nonce, stackId, kid: "k2" });
    await service.createIssuerKey(ctx(alice), { path: { stackId }, body: { kid: "k2", algorithm: "ES256", ...signed2 } });
    expect(await service.deleteIssuerKey(ctx(alice), { path: { stackId, kid: "k1" }, body: { toState: "retiring" } }, { ifMatch: '"1"' }))
      .toMatchObject({ state: "retiring", revision: 2 });
  }, 10_000);

  test("records audit context, makes creates idempotent, and snapshot-binds cursors", async () => {
    const { service } = await createService();
    const first = await service.createStack(ctx(alice), { body: { displayName: "Same" } }, { idempotencyKey: "create-1" });
    expect(await service.createStack(ctx(alice), { body: { displayName: "Same" } }, { idempotencyKey: "create-1" })).toEqual(first);
    expectError(await service.createStack(ctx(alice), { body: { displayName: "Different" } }, { idempotencyKey: "create-1" }), CasAdminErrorCodes.IDEMPOTENCY_CONFLICT);
    if ("error" in first) throw new Error(first.error);
    const events = await service.listControlAuditEvents(ctx(alice), { path: { stackId: first.stackId }, query: { limit: 10 } });
    expect(events).toMatchObject({ items: [{ action: "stack.created", requestId: "req-1", traceId: "trace-1" }] });
    await createStack(service, alice, "Two");
    await createStack(service, alice, "Three");
    const page = await service.listStacks(ctx(alice), { query: { limit: 2 } });
    if (!("items" in page) || !page.nextCursor) throw new Error("cursor missing");
    await createStack(service, bob, "Concurrent");
    expectError(await service.listStacks(ctx(alice), { query: { limit: 2, cursor: page.nextCursor } }), CasAdminErrorCodes.INVALID_CURSOR);
    expectError(await service.listStacks(ctx(alice), { query: { cursor: "!!!" } }), CasAdminErrorCodes.INVALID_CURSOR);
  });

  test("records session audit without advancing the control snapshot", async () => {
    const { db, service } = await createService(() => 123_456);
    await service.recordSessionAudit(
      ctx(alice),
      ControlAuditActions.sessionLogin,
      `${alice.identityIssuer}:${alice.subject}`,
    );
    expect(await db.prepare(
      "SELECT action, target, request_id, trace_id, created_at FROM cas_control_audit_events",
    ).first()).toEqual({
      action: "session.login",
      target: `${alice.identityIssuer}:${alice.subject}`,
      request_id: "req-1",
      trace_id: "trace-1",
      created_at: 123_456,
    });
    expect(await db.prepare("SELECT value FROM cas_control_meta WHERE key = 'snapshot'").first()).toBeNull();
  });

  test("stores, touches, expires, deletes, and prunes encrypted sessions", async () => {
    let clock = 1_000_000;
    const { db } = await createService();
    const store = new ControlSessionStore(db, () => clock);
    await store.create("one", "encrypted", 60_000);
    expect(await store.read("one")).toMatchObject({ encryptedPayload: "encrypted", expiresAt: 1_060_000 });
    clock = 1_010_000;
    await store.touch("one", 60_000);
    expect((await store.read("one"))?.expiresAt).toBe(1_070_000);
    await store.create("expired", "old", 1);
    clock = 1_020_000;
    expect(await store.read("expired")).toBeNull();
    await store.create("prune", "old", 1);
    clock = 1_030_000;
    expect(await store.pruneExpired()).toBe(1);
    await store.delete("one");
    expect(await store.read("one")).toBeNull();
  });
});
