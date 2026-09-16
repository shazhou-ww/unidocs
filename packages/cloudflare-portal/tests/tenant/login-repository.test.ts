import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { AdminAccessError, googleIdentityFromConfirmedLogin } from "@unidocs/portal-service";
import { hashSessionSecret } from "../../src/auth.js";
import { D1TenantLoginRepository, TENANT_MEMBER_SESSION_LIMIT } from "../../src/tenant/login-repository.js";
import { D1TenantSessionStore } from "../../src/tenant/session.js";
import { insertMember } from "./members.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const NOW = 1_800_000_000;
let real: RealD1;
let repository: D1TenantLoginRepository;

beforeEach(async () => {
  real = await startRealD1();
  repository = new D1TenantLoginRepository(real.db, () => NOW);
});
afterEach(async () => { await real.dispose(); });

function identity(subject = "google-subject", email = "Member@Example.com") {
  return googleIdentityFromConfirmedLogin({ iss: "https://accounts.google.com", sub: subject, email, email_verified: true }, NOW);
}

async function invite(email = "member@example.com", createdAt = NOW - 60) {
  return insertMember(real.db, { tenantId: "t1", principalId: "user:invited", email, bound: false, createdAt, memberId: "member-invited" });
}

/** Runs `before` right ahead of the repository's batch: a deterministic interleaving. */
function interleaved(db: D1Database, before: () => Promise<void>): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { await before(); return target.batch(statements); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const rows = async (sql: string) => (await real.db.prepare(sql).all()).results;

describe("D1TenantLoginRepository.completeLogin", () => {
  it("binds an invitation by normalized email and issues a working session", async () => {
    await invite();
    const result = await repository.completeLogin(identity(), "req-1");
    expect(result).toMatchObject({ memberId: "member-invited", tenantId: "t1", principalId: "user:invited" });
    expect(await rows("SELECT issuer, subject, revision FROM portal_tenant_members")).toEqual([
      { issuer: "https://accounts.google.com", subject: "google-subject", revision: 1 },
    ]);
    const session = await new D1TenantSessionStore(real.db).find(await hashSessionSecret(result.token), NOW);
    expect(session).toMatchObject({ tenantId: "t1", principalId: "user:invited" });
    expect(await rows("SELECT action, request_id FROM portal_tenant_auth_audit ORDER BY action")).toEqual([
      { action: "member.bound", request_id: "req-1" },
      { action: "session.created", request_id: "req-1" },
    ]);
  });

  it("finds an already bound member by Google identity, not by email, and provisions no new tenant", async () => {
    await invite();
    const first = await repository.completeLogin(identity(), "req-1");
    const again = await repository.completeLogin(identity("google-subject", "renamed@example.com"), "req-2");
    expect(again.memberId).toBe("member-invited");
    expect(again.tenantId).toBe(first.tenantId);
    expect(again.tenantId).toBe("t1");
    expect(await rows("SELECT action FROM portal_tenant_auth_audit WHERE request_id = 'req-2'")).toEqual([{ action: "session.created" }]);
    expect(await rows("SELECT COUNT(*) AS n FROM portal_tenant_members")).toEqual([{ n: 1 }]);
  });

  it("provisions a brand-new identity its own tenant, member row, audit rows and a working session", async () => {
    const result = await repository.completeLogin(identity(), "req-1");
    expect(result.tenantId).toMatch(/^t-/);
    expect(await rows(`SELECT tenant_id, principal_id, email, issuer, subject, active, added_by FROM portal_tenant_members
      WHERE member_id = '${result.memberId}'`)).toEqual([{
      tenant_id: result.tenantId, principal_id: result.principalId, email: "member@example.com",
      issuer: "https://accounts.google.com", subject: "google-subject", active: 1, added_by: "self-signup",
    }]);
    const session = await new D1TenantSessionStore(real.db).find(await hashSessionSecret(result.token), NOW);
    expect(session).toMatchObject({ tenantId: result.tenantId, principalId: result.principalId });
    expect(await rows("SELECT action, request_id FROM portal_tenant_auth_audit ORDER BY action")).toEqual([
      { action: "member.bound", request_id: "req-1" },
      { action: "session.created", request_id: "req-1" },
    ]);
  });

  it("provisions two different identities into two different tenants, each seeing only their own", async () => {
    const first = await repository.completeLogin(identity("subject-a", "a@example.com"), "req-a");
    const second = await repository.completeLogin(identity("subject-b", "b@example.com"), "req-b");
    expect(first.tenantId).not.toBe(second.tenantId);
    const store = new D1TenantSessionStore(real.db);
    const sessionA = await store.find(await hashSessionSecret(first.token), NOW);
    const sessionB = await store.find(await hashSessionSecret(second.token), NOW);
    expect(sessionA?.tenantId).toBe(first.tenantId);
    expect(sessionB?.tenantId).toBe(second.tenantId);
    expect(sessionA?.tenantId).not.toBe(sessionB?.tenantId);
  });

  it("denies a confirmation older than the invitation", async () => {
    await invite("member@example.com", NOW + 1);
    const late = new D1TenantLoginRepository(real.db, () => NOW + 1);
    await expect(late.completeLogin(identity(), "req-1")).rejects.toEqual(new AdminAccessError("forbidden"));
  });

  it("provisions a removed member a fresh, empty tenant distinct from their old one, leaving the old tenant's documents alone", async () => {
    await invite();
    const first = await repository.completeLogin(identity(), "req-1");
    await real.db.prepare(
      "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, created_at) VALUES (?, 'doc-1', 'Doc', 'markdown', ?)",
    ).bind(first.tenantId, NOW).run();
    // An administrator removes the member from that tenant. Removal means
    // "removed from that tenant", not "locked out": the same identity signing
    // in again is provisioned a brand-new, empty tenant.
    await real.db.prepare("UPDATE portal_tenant_members SET active = 0 WHERE member_id = ?").bind(first.memberId).run();
    const second = await repository.completeLogin(identity(), "req-2");
    expect(second.tenantId).not.toBe(first.tenantId);
    expect(await rows(`SELECT tenant_id FROM portal_documents WHERE document_id = 'doc-1'`)).toEqual([{ tenant_id: first.tenantId }]);
    expect(await rows(`SELECT tenant_id FROM portal_documents WHERE tenant_id = '${second.tenantId}'`)).toEqual([]);
  });

  it("writes nothing when the member is removed between the read and the batch", async () => {
    await invite();
    const racing = new D1TenantLoginRepository(interleaved(real.db, async () => {
      await real.db.prepare("UPDATE portal_tenant_members SET active = 0").run();
    }), () => NOW);
    await expect(racing.completeLogin(identity(), "req-1")).rejects.not.toBeInstanceOf(AdminAccessError);
    expect(await rows("SELECT * FROM portal_tenant_sessions")).toEqual([]);
    expect(await rows("SELECT * FROM portal_tenant_auth_audit")).toEqual([]);
    expect(await rows("SELECT subject FROM portal_tenant_members")).toEqual([{ subject: null }]);
  });

  it("lets only one of two racing sign-ins claim the same invitation", async () => {
    await invite();
    const other = new D1TenantLoginRepository(real.db, () => NOW);
    const racing = new D1TenantLoginRepository(interleaved(real.db, async () => {
      await other.completeLogin(identity(), "req-winner");
    }), () => NOW);
    await expect(racing.completeLogin(identity(), "req-loser")).rejects.toBeDefined();
    expect(await rows("SELECT request_id FROM portal_tenant_auth_audit WHERE action = 'session.created'")).toEqual([{ request_id: "req-winner" }]);
  });

  it("lets only one of two racing signups for the same brand-new identity provision a tenant; the loser writes nothing", async () => {
    const other = new D1TenantLoginRepository(real.db, () => NOW);
    const racing = new D1TenantLoginRepository(interleaved(real.db, async () => {
      await other.completeLogin(identity(), "req-winner");
    }), () => NOW);
    await expect(racing.completeLogin(identity(), "req-loser")).rejects.toBeDefined();
    expect(await rows("SELECT COUNT(*) AS n FROM portal_tenant_members")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT request_id FROM portal_tenant_auth_audit WHERE action = 'session.created'")).toEqual([{ request_id: "req-winner" }]);
    expect(await rows("SELECT request_id FROM portal_tenant_auth_audit WHERE action = 'member.bound'")).toEqual([{ request_id: "req-winner" }]);
  });

  it("keeps at most ten sessions per member, dropping the oldest and every expired one", async () => {
    await insertMember(real.db, { tenantId: "t1", principalId: "user:bound", memberId: "member-bound" });
    await real.db.prepare("UPDATE portal_tenant_members SET issuer = 'https://accounts.google.com', subject = 'google-subject', email = 'member@example.com'").run();
    const store = new D1TenantSessionStore(real.db);
    await store.issue("t1", "user:bound", NOW - 28_800); // expires exactly at NOW
    for (let index = 0; index < TENANT_MEMBER_SESSION_LIMIT; index += 1) await store.issue("t1", "user:bound", NOW - 100 + index);
    await repository.completeLogin(identity(), "req-11");
    expect(await rows("SELECT created_at FROM portal_tenant_sessions ORDER BY created_at")).toEqual(
      [...Array.from({ length: TENANT_MEMBER_SESSION_LIMIT - 1 }, (_, index) => ({ created_at: NOW - 99 + index })), { created_at: NOW }],
    );
  });
});

describe("D1TenantLoginRepository transactions", () => {
  const transaction = (state: string, createdAt: number) => ({
    stateHash: state, browserHash: "browser", verifier: "v".repeat(43), nonce: "n".repeat(43),
    returnTo: "/portal/", createdAt, expiresAt: createdAt + 600,
  });

  it("takes a transaction once, bound to its browser", async () => {
    await repository.put(transaction("s1", NOW));
    expect(await repository.take("s1", "other-browser", NOW)).toBeNull();
    expect(await repository.take("s1", "browser", NOW)).toMatchObject({ stateHash: "s1", returnTo: "/portal/" });
    expect(await repository.take("s1", "browser", NOW)).toBeNull();
  });

  it("sweeps at most one hundred expired transactions on each put", async () => {
    for (let index = 0; index < 150; index += 1) await repository.put(transaction(`old-${index}`, NOW - 10_000));
    await repository.put(transaction("fresh", NOW));
    const left = await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_login_transactions").first<{ n: number }>();
    expect(left?.n).toBe(51);
  });
});
