import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { CasAdminErrorCodes } from "@unicas/admin-protocol";
import type { CasAdminErrorResponse, CasOperatorIdentityKey } from "@unicas/admin-protocol";
import { ControlPlaneService } from "@unicas/control-plane";
import type { ControlPlaneCallContext } from "@unicas/control-plane";
import { migrateControlSchema } from "../src/control-schema.js";
import { ControlSessionStore } from "../src/control-sessions.js";

let miniflare: Miniflare | undefined;
afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
});

async function createService(now?: () => number): Promise<{ db: D1Database; service: ControlPlaneService }> {
  miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "control-plane-service-test",
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2025-08-17",
    d1Databases: { DB: "control-plane-service-test-db" },
  }] }));
  await miniflare.ready;
  const db = await miniflare.getD1Database("DB", "control-plane-service-test");
  await migrateControlSchema(db);
  return { db, service: new ControlPlaneService(db, now ? { now } : {}) };
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
async function createStack(service: ControlPlaneService, identity = alice, displayName = "Stack"): Promise<string> {
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
    const invitation = await service.createMemberInvitation(ctx(alice), { path: { stackId }, body: { emailConstraint: "bob-sub@example.com" } });
    if (!("invitation" in invitation)) throw new Error("invite failed");
    const token = invitation.acceptUrl.split("/").pop()!;
    expectError(await service.acceptMemberInvitation(ctx(bob, "wrong@example.com"), { path: { token } }), CasAdminErrorCodes.NOT_FOUND);
    expect(await service.acceptMemberInvitation(ctx(bob), { path: { token } })).toMatchObject({ stackId, subject: "bob-sub" });
    expectError(await service.acceptMemberInvitation(ctx(bob), { path: { token } }), CasAdminErrorCodes.NOT_FOUND);
    expect(await service.deleteMember(ctx(alice), { path: { stackId }, query: alice }, { ifMatch: '"1"' })).toEqual({ ok: true });

    const expiring = await service.createMemberInvitation(ctx(bob), { path: { stackId } });
    if (!("invitation" in expiring)) throw new Error("invite failed");
    clock += 25 * 60 * 60 * 1000;
    expectError(await service.acceptMemberInvitation(ctx(alice), { path: { token: expiring.acceptUrl.split("/").pop()! } }), CasAdminErrorCodes.NOT_FOUND);
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
