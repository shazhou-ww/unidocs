import { afterEach, describe, expect, test } from "vitest";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import {
  ControlPlaneService,
  ControlSessionStore,
  migrateControlSchema,
} from "../src/index.js";
import type { ControlPlaneCallContext } from "../src/index.js";
import type {
  CasAdminErrorResponse,
  CasOperatorIdentityKey,
} from "@unicas/protocol-admin";
import { CasAdminErrorCodes } from "@unicas/protocol-admin";

let miniflare: Miniflare | undefined;

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
});

async function createService(now?: () => number): Promise<{
  db: D1Database;
  service: ControlPlaneService;
}> {
  miniflare = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "control-plane-test",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      compatibilityDate: "2025-08-17",
      d1Databases: { DB: "control-plane-test-db" },
    }],
  }));
  await miniflare.ready;
  const db = await miniflare.getD1Database("DB", "control-plane-test");
  await migrateControlSchema(db);
  const service = new ControlPlaneService(db, now ? { now } : {});
  return { db, service };
}

const GOOGLE = "https://accounts.google.com";
const alice: CasOperatorIdentityKey = { identityIssuer: GOOGLE, subject: "alice-sub" };
const bob: CasOperatorIdentityKey = { identityIssuer: GOOGLE, subject: "bob-sub" };

function ctx(
  identity: CasOperatorIdentityKey,
  email: string | null = `${identity.subject}@example.com`,
): ControlPlaneCallContext {
  return {
    identity,
    profile: { displayName: identity.subject, emailForDisplay: email },
    requestId: "req-1",
    traceId: "trace-1",
  };
}

function expectError(response: unknown, code: CasAdminErrorResponse["error"]): void {
  expect(response).toMatchObject({ error: code });
}

async function signedPossessionProof(input: {
  nonce: string;
  stackId: string;
  kid: string;
  algorithm: "ES256" | "RS256" | "EdDSA";
}): Promise<{ publicJwk: Record<string, unknown>; possessionProof: string }> {
  const { publicKey, privateKey } = await generateKeyPair(input.algorithm);
  const challenge = [
    "cas-possession-v1",
    input.nonce,
    input.stackId,
    input.kid,
    input.algorithm,
  ].join("\n");
  const possessionProof = await new CompactSign(new TextEncoder().encode(challenge))
    .setProtectedHeader({ alg: input.algorithm })
    .sign(privateKey);
  return { publicJwk: (await exportJWK(publicKey)) as Record<string, unknown>, possessionProof };
}

async function createStackFor(
  service: ControlPlaneService,
  identity: CasOperatorIdentityKey,
  displayName = "Stack",
  idempotencyKey?: string,
): Promise<string> {
  const response = await service.createStack(ctx(identity), {
    body: { displayName },
  }, idempotencyKey ? { idempotencyKey } : {});
  if ("error" in response) throw new Error(`createStack failed: ${response.error}`);
  return response.stackId;
}

describe("control-plane service", () => {
  test("me() upserts the operator identity and lists memberships", async () => {
    const { service } = await createService();
    const first = await service.me(ctx(alice));
    expect(first).toMatchObject({
      identity: { identityIssuer: GOOGLE, subject: "alice-sub", displayName: "alice-sub" },
      memberships: [],
    });
    const changed = await service.me(ctx(alice, "new@example.com"));
    expect(changed).toMatchObject({
      identity: { emailForDisplay: "new@example.com" },
    });
  });

  test("stack creation registers the caller as the first member", async () => {
    const { service } = await createService();
    const stackId = await createStackFor(service, alice, "Alice Stack");
    expect(stackId).toMatch(/^cas_[A-Za-z0-9_-]+$/);
    const list = await service.listStacks(ctx(alice), {});
    expect("items" in list && list.items).toHaveLength(1);
    expect("items" in list && list.items[0]).toMatchObject({
      stackId,
      displayName: "Alice Stack",
      status: "active",
      revision: 1,
    });
    // Bob does not see Alice's stack.
    const bobList = await service.listStacks(ctx(bob), {});
    expect("items" in bobList && bobList.items).toHaveLength(0);
  });

  test("stack metadata patch requires If-Match and increments revision", async () => {
    const { service } = await createService();
    const stackId = await createStackFor(service, alice);
    const noMatch = await service.patchStack(ctx(alice), {
      path: { stackId },
      body: { displayName: "Renamed" },
    }, {});
    expectError(noMatch, CasAdminErrorCodes.PRECONDITION_REQUIRED);
    const stale = await service.patchStack(ctx(alice), {
      path: { stackId },
      body: { displayName: "Renamed" },
    }, { ifMatch: '"99"' });
    expectError(stale, CasAdminErrorCodes.REVISION_MISMATCH);
    const ok = await service.patchStack(ctx(alice), {
      path: { stackId },
      body: { displayName: "Renamed" },
    }, { ifMatch: '"1"' });
    expect(ok).toMatchObject({ displayName: "Renamed", revision: 2 });
    const get = await service.getStack(ctx(alice), { path: { stackId } });
    expect(get).toMatchObject({ displayName: "Renamed", revision: 2 });
  });

  test("non-members cannot read stack resources", async () => {
    const { service } = await createService();
    const stackId = await createStackFor(service, alice);
    const get = await service.getStack(ctx(bob), { path: { stackId } });
    expectError(get, CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED);
    const members = await service.listMembers(ctx(bob), { path: { stackId } });
    expectError(members, CasAdminErrorCodes.STACK_MEMBERSHIP_REQUIRED);
  });

  test("last member cannot be deleted; replacement enables transfer", async () => {
    const { service } = await createService();
    const stackId = await createStackFor(service, alice);
    const last = await service.deleteMember(ctx(alice), {
      path: { stackId },
      query: { identityIssuer: GOOGLE, subject: "alice-sub" },
    }, { ifMatch: '"1"' });
    expectError(last, CasAdminErrorCodes.LAST_MEMBER);

    // Invite + accept Bob, then Alice removes herself: management transfer.
    const invite = await service.createMemberInvitation(ctx(alice), {
      path: { stackId },
      body: { emailConstraint: "bob-sub@example.com" },
    });
    if (!("invitation" in invite)) throw new Error("invite failed");
    const acceptUrl = invite.acceptUrl;
    const token = acceptUrl.split("/").pop()!;
    const accepted = await service.acceptMemberInvitation(ctx(bob), {
      path: { token },
    });
    expect(accepted).toMatchObject({ stackId, subject: "bob-sub" });

    const removed = await service.deleteMember(ctx(alice), {
      path: { stackId },
      query: { identityIssuer: GOOGLE, subject: "alice-sub" },
    }, { ifMatch: '"1"' });
    expect(removed).toEqual({ ok: true });
    const members = await service.listMembers(ctx(bob), { path: { stackId } });
    expect("items" in members && members.items).toHaveLength(1);
    expect("items" in members && members.items[0]?.subject).toBe("bob-sub");
  });

  test("invitation acceptance enforces email constraint and one-time use", async () => {
    const { service } = await createService();
    const stackId = await createStackFor(service, alice);
    const invite = await service.createMemberInvitation(ctx(alice), {
      path: { stackId },
      body: { emailConstraint: "bob-sub@example.com" },
    });
    if (!("invitation" in invite)) throw new Error("invite failed");
    const token = invite.acceptUrl.split("/").pop()!;

    // Wrong email cannot accept.
    const wrongEmail = await service.acceptMemberInvitation(
      { ...ctx(bob), profile: { displayName: "bob", emailForDisplay: "other@example.com" } },
      { path: { token } },
    );
    expectError(wrongEmail, CasAdminErrorCodes.NOT_FOUND);

    const accepted = await service.acceptMemberInvitation(ctx(bob), { path: { token } });
    expect(accepted).toMatchObject({ stackId, subject: "bob-sub" });
    // One-time token: a second accept finds the consumed invitation.
    const second = await service.acceptMemberInvitation(ctx(bob), { path: { token } });
    expectError(second, CasAdminErrorCodes.NOT_FOUND);
  });

  test("expired invitations cannot be accepted", async () => {
    let clock = 1_000_000;
    const { service } = await createService(() => clock);
    const stackId = await createStackFor(service, alice);
    const invite = await service.createMemberInvitation(ctx(alice), { path: { stackId } });
    if (!("invitation" in invite)) throw new Error("invite failed");
    const token = invite.acceptUrl.split("/").pop()!;
    clock += 25 * 60 * 60 * 1000; // past the 24h TTL
    const result = await service.acceptMemberInvitation(ctx(bob), { path: { token } });
    expectError(result, CasAdminErrorCodes.NOT_FOUND);
  });

  test("issuer is a singleton with globally unique issuer value", async () => {
    const { service } = await createService();
    const stackA = await createStackFor(service, alice, "A");
    const stackB = await createStackFor(service, alice, "B");
    const created = await service.putIssuer(ctx(alice), {
      path: { stackId: stackA },
      body: { issuer: "https://issuer.example/a", audience: "unidocs-cas" },
    }, {});
    expect(created).toMatchObject({ stackId: stackA, issuer: "https://issuer.example/a", revision: 1 });
    const conflict = await service.putIssuer(ctx(alice), {
      path: { stackId: stackB },
      body: { issuer: "https://issuer.example/a", audience: "unidocs-cas" },
    }, {});
    expectError(conflict, CasAdminErrorCodes.ISSUER_CONFLICT);
    // Issuer value is immutable; audience is replaceable with If-Match.
    const immutable = await service.putIssuer(ctx(alice), {
      path: { stackId: stackA },
      body: { issuer: "https://issuer.example/other", audience: "unidocs-cas" },
    }, { ifMatch: '"1"' });
    expectError(immutable, CasAdminErrorCodes.INVALID_REQUEST);
    const replace = await service.putIssuer(ctx(alice), {
      path: { stackId: stackA },
      body: { issuer: "https://issuer.example/a", audience: "unidocs-cas-v2" },
    }, { ifMatch: '"1"' });
    expect(replace).toMatchObject({ audience: "unidocs-cas-v2", revision: 2 });
    // Replace without If-Match fails.
    const noMatch = await service.putIssuer(ctx(alice), {
      path: { stackId: stackA },
      body: { issuer: "https://issuer.example/a", audience: "unidocs-cas-v3" },
    }, {});
    expectError(noMatch, CasAdminErrorCodes.PRECONDITION_REQUIRED);
  });

  test("issuer keys require a valid possession proof and rotate safely", async () => {
    const { service } = await createService();
    const stackId = await createStackFor(service, alice);
    await service.putIssuer(ctx(alice), {
      path: { stackId },
      body: { issuer: "https://issuer.example/a", audience: "unidocs-cas" },
    }, {});
    const challenge = await service.createPossessionChallenge(ctx(alice), {
      stackId,
      kid: "k1",
      algorithm: "ES256",
    });
    if (!("nonce" in challenge)) throw new Error("challenge failed");

    // A proof signed with a different key cannot register.
    const other = await generateKeyPair("ES256");
    const forged = await signedPossessionProof({ nonce: challenge.nonce, stackId, kid: "k1", algorithm: "ES256" });
    const badKey = await service.createIssuerKey(ctx(alice), {
      path: { stackId },
      body: {
        kid: "k1",
        algorithm: "ES256",
        publicJwk: (await exportJWK(other.publicKey)) as Record<string, unknown>,
        possessionProof: forged.possessionProof,
      },
    });
    expectError(badKey, CasAdminErrorCodes.INVALID_REQUEST);

    const proof = await signedPossessionProof({ nonce: challenge.nonce, stackId, kid: "k1", algorithm: "ES256" });
    const created = await service.createIssuerKey(ctx(alice), {
      path: { stackId },
      body: { kid: "k1", algorithm: "ES256", publicJwk: proof.publicJwk, possessionProof: proof.possessionProof },
    });
    expect(created).toMatchObject({ kid: "k1", state: "active", revision: 1 });

    // The same one-time challenge cannot be reused for another kid.
    const reused = await signedPossessionProof({ nonce: challenge.nonce, stackId, kid: "k2", algorithm: "ES256" });
    const reuse = await service.createIssuerKey(ctx(alice), {
      path: { stackId },
      body: { kid: "k2", algorithm: "ES256", publicJwk: reused.publicJwk, possessionProof: reused.possessionProof },
    });
    expectError(reuse, CasAdminErrorCodes.INVALID_REQUEST);

    // The only active key cannot be retired.
    const last = await service.deleteIssuerKey(ctx(alice), {
      path: { stackId, kid: "k1" },
    }, { ifMatch: '"1"' });
    expectError(last, CasAdminErrorCodes.KEY_STATE_CONFLICT);

    // Add a second key, then retire the first.
    const c2 = await service.createPossessionChallenge(ctx(alice), { stackId, kid: "k2", algorithm: "ES256" });
    if (!("nonce" in c2)) throw new Error("challenge 2 failed");
    const proof2 = await signedPossessionProof({ nonce: c2.nonce, stackId, kid: "k2", algorithm: "ES256" });
    const created2 = await service.createIssuerKey(ctx(alice), {
      path: { stackId },
      body: { kid: "k2", algorithm: "ES256", publicJwk: proof2.publicJwk, possessionProof: proof2.possessionProof },
    });
    expect(created2).toMatchObject({ kid: "k2", state: "active" });

    const retired = await service.deleteIssuerKey(ctx(alice), {
      path: { stackId, kid: "k1" },
      body: { toState: "retiring" },
    }, { ifMatch: '"1"' });
    expect(retired).toMatchObject({ kid: "k1", state: "retiring", revision: 2 });
    // A key cannot transition to the same state.
    const back = await service.deleteIssuerKey(ctx(alice), {
      path: { stackId, kid: "k1" },
      body: { toState: "retiring" },
    }, { ifMatch: '"2"' });
    expectError(back, CasAdminErrorCodes.KEY_STATE_CONFLICT);
  });

  test("refDomains: create-or-get, reserved rejection, and retirement", async () => {
    const { service } = await createService();
    const stackId = await createStackFor(service, alice);
    const reserved = await service.createRefDomain(ctx(alice), {
      path: { stackId },
      body: { refDomain: "_legacy" },
    });
    expectError(reserved, CasAdminErrorCodes.INVALID_REQUEST);
    const bad = await service.createRefDomain(ctx(alice), {
      path: { stackId },
      body: { refDomain: "Doc" },
    });
    expectError(bad, CasAdminErrorCodes.INVALID_REQUEST);

    const created = await service.createRefDomain(ctx(alice), {
      path: { stackId },
      body: { refDomain: "doc" },
    });
    expect(created).toMatchObject({ refDomain: "doc", status: "active", revision: 1 });
    const duplicate = await service.createRefDomain(ctx(alice), {
      path: { stackId },
      body: { refDomain: "doc" },
    });
    expect(duplicate).toMatchObject({ refDomain: "doc", revision: 1 });

    const retired = await service.patchRefDomain(ctx(alice), {
      path: { stackId, refDomain: "doc" },
      body: { status: "retired" },
    }, { ifMatch: '"1"' });
    expect(retired).toMatchObject({ status: "retired", revision: 2 });
    const recreate = await service.createRefDomain(ctx(alice), {
      path: { stackId },
      body: { refDomain: "doc" },
    });
    expectError(recreate, CasAdminErrorCodes.DOMAIN_RETIRED);
    const touchRetired = await service.patchRefDomain(ctx(alice), {
      path: { stackId, refDomain: "doc" },
      body: { status: "write_disabled" },
    }, { ifMatch: '"2"' });
    expectError(touchRetired, CasAdminErrorCodes.DOMAIN_RETIRED);
  });

  test("control audit records every mutation with actor and target", async () => {
    const { service } = await createService();
    const stackId = await createStackFor(service, alice);
    await service.createRefDomain(ctx(alice), { path: { stackId }, body: { refDomain: "doc" } });
    const events = await service.listControlAuditEvents(ctx(alice), {
      path: { stackId },
      query: { limit: 50 },
    });
    if (!("items" in events)) throw new Error("audit list failed");
    const actions = events.items.map((event) => event.action);
    expect(actions).toContain("stack.created");
    expect(actions).toContain("refdomain.created");
    expect(events.items[0]).toMatchObject({
      stackId,
      actor: { identityIssuer: GOOGLE, subject: "alice-sub" },
      requestId: "req-1",
      traceId: "trace-1",
      caller: null,
    });
  });

  test("creation idempotency: same key returns the stored response; different payload conflicts", async () => {
    const { service } = await createService();
    const first = await service.createStack(ctx(alice), {
      body: { displayName: "Same" },
    }, { idempotencyKey: "create-stack-1" });
    const second = await service.createStack(ctx(alice), {
      body: { displayName: "Same" },
    }, { idempotencyKey: "create-stack-1" });
    expect(second).toEqual(first);
    const conflict = await service.createStack(ctx(alice), {
      body: { displayName: "Different" },
    }, { idempotencyKey: "create-stack-1" });
    expectError(conflict, CasAdminErrorCodes.IDEMPOTENCY_CONFLICT);
  });

  test("list cursors are bound to the control snapshot", async () => {
    const { service } = await createService();
    for (let i = 0; i < 3; i += 1) {
      await createStackFor(service, alice, `Stack ${i}`);
    }
    const page = await service.listStacks(ctx(alice), { query: { limit: 2 } });
    if (!("items" in page) || !page.nextCursor) throw new Error("expected a cursor");
    expect(page.items).toHaveLength(2);
    // A concurrent mutation bumps the snapshot: the cursor must be rejected.
    await createStackFor(service, bob, "Intruder");
    const next = await service.listStacks(ctx(alice), { query: { limit: 2, cursor: page.nextCursor } });
    expectError(next, CasAdminErrorCodes.INVALID_CURSOR);
    // Malformed cursors are rejected outright.
    const malformed = await service.listStacks(ctx(alice), { query: { cursor: "!!!" } });
    expectError(malformed, CasAdminErrorCodes.INVALID_CURSOR);
  });

  test("session store round-trips encrypted payloads and prunes expired rows", async () => {
    const { db } = await createService();
    const store = new ControlSessionStore(db, () => 1_000_000);
    await store.create("sess_1", "encrypted-blob", 60_000);
    const read = await store.read("sess_1");
    expect(read).toMatchObject({
      sessionId: "sess_1",
      encryptedPayload: "encrypted-blob",
      expiresAt: 1_060_000,
    });
    await store.touch("sess_1", 60_000);
    const touched = await store.read("sess_1");
    expect(touched?.expiresAt).toBe(1_060_000);
    expect(await store.read("missing")).toBeNull();
    await store.delete("sess_1");
    expect(await store.read("sess_1")).toBeNull();
  });
});
