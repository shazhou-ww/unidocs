import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { googleIdentityFromConfirmedLogin, type AdminContext } from "@unidocs/portal-service";
import { hashSessionSecret } from "../src/auth.js";
import { D1PortalAuthRepository } from "../src/auth-repository.js";
import { createTenantMembersHttp } from "../src/tenant-members-http.js";
import { D1TenantMemberRepository } from "../src/tenant-members-repository.js";
import { D1TenantSessionStore } from "../src/tenant/session.js";
import { startRealD1, type RealD1 } from "./tenant/real-d1.js";

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

const ORIGIN = "https://portal.example";
const NOW = Math.floor(Date.now() / 1000);
let real: RealD1;
let admin: AdminContext;
let handle: ReturnType<typeof createTenantMembersHttp>;

beforeEach(async () => {
  real = await startRealD1();
  const identity = googleIdentityFromConfirmedLogin({ iss: "https://accounts.google.com", sub: "admin-sub", email: "admin@example.com", email_verified: true }, NOW);
  const issued = await new D1PortalAuthRepository(real.db, () => NOW).completeLogin(identity, "admin@example.com", "bootstrap");
  admin = { memberId: issued.memberId, identity, transport: "session", sessionHash: issued.session.sessionHash };
  handle = createTenantMembersHttp(new D1TenantMemberRepository(real.db, () => NOW));
});
afterEach(async () => { await real.dispose(); });

let keys = 0;
function call(method: string, path: string, options: { body?: unknown; ifMatch?: string; key?: string } = {}) {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["idempotency-key"] = options.key ?? `key-${keys += 1}`;
  if (options.ifMatch) headers["if-match"] = options.ifMatch;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return handle(new Request(`${ORIGIN}/admin/api/v1${path}`, {
    method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), admin, "req-test");
}

async function add(email = "Member@Example.com", tenantId = "t1") {
  const response = await call("POST", "/tenant-members", { body: { tenantId, email } });
  expect(response.status).toBe(201);
  return await response.json() as { memberId: string; principalId: string; etag: string };
}

async function bindAndSignIn(memberId: string) {
  await real.db.prepare("UPDATE portal_tenant_members SET issuer = 'https://accounts.google.com', subject = ? WHERE member_id = ?").bind(`sub-${memberId}`, memberId).run();
  const row = await real.db.prepare("SELECT tenant_id, principal_id FROM portal_tenant_members WHERE member_id = ?").bind(memberId).first<{ tenant_id: string; principal_id: string }>();
  const store = new D1TenantSessionStore(real.db);
  const { token } = await store.issue(row!.tenant_id, row!.principal_id, NOW);
  return { store, hash: await hashSessionSecret(token) };
}

async function currentEtag(memberId: string) {
  const list = await (await call("GET", "/tenant-members")).json() as { items: { memberId: string; etag: string }[] };
  return list.items.find(item => item.memberId === memberId)!.etag;
}

describe("tenant members admin API (real D1)", () => {
  it("adds a normalized member, lists it, and audits the addition", async () => {
    const created = await add();
    expect(created.principalId).toMatch(/^user:[0-9a-f-]{36}$/);
    const list = await (await call("GET", "/tenant-members?tenantId=t1")).json() as { items: unknown[]; nextCursor: string | null };
    expect(list).toEqual({
      items: [expect.objectContaining({ memberId: created.memberId, tenantId: "t1", email: "member@example.com", bound: false, addedBy: admin.memberId, etag: created.etag })],
      nextCursor: null,
    });
    expect(await real.db.prepare("SELECT action, resource_type, resource_id FROM portal_admin_audit WHERE action LIKE 'tenant_member.%'").all())
      .toMatchObject({ results: [{ action: "tenant_member.added", resource_type: "tenant_member", resource_id: created.memberId }] });
  });

  it("filters the list by tenant and pages through it", async () => {
    await add("a@example.com", "t1");
    await add("b@example.com", "t2");
    await add("c@example.com", "t1");
    const first = await (await call("GET", "/tenant-members?tenantId=t1&limit=1")).json() as { items: { email: string }[]; nextCursor: string };
    const second = await (await call("GET", `/tenant-members?tenantId=t1&limit=1&cursor=${first.nextCursor}`)).json() as { items: { email: string }[]; nextCursor: string | null };
    expect([...first.items, ...second.items].map(item => item.email).sort()).toEqual(["a@example.com", "c@example.com"]);
    expect(second.nextCursor).toBeNull();
    expect((await call("GET", "/tenant-members?color=red")).status).toBe(400);
  });

  it("refuses a second active membership for the same email, in any tenant", async () => {
    await add("member@example.com", "t1");
    const again = await call("POST", "/tenant-members", { body: { tenantId: "t2", email: "MEMBER@example.com" } });
    expect(again.status).toBe(409);
    expect((await again.json() as { error: { code: string } }).error.code).toBe("tenant_member_exists");
  });

  it("replays an add with the same key and refuses the key for a different body", async () => {
    const first = await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "a@example.com" }, key: "same" });
    const replay = await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "a@example.com" }, key: "same" });
    expect(await replay.json()).toEqual(await first.json());
    const conflict = await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "b@example.com" }, key: "same" });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe("idempotency_conflict");
  });

  it("removes a member under its ETag, ends its sessions, keeps the row, and allows re-adding with a new principal", async () => {
    const created = await add();
    const { store, hash } = await bindAndSignIn(created.memberId);
    expect(await store.find(hash, NOW)).not.toBeNull();

    expect((await call("DELETE", `/tenant-members/${created.memberId}`)).status).toBe(428);
    expect((await call("DELETE", `/tenant-members/${created.memberId}`, { ifMatch: created.etag })).status).toBe(412);
    const removed = await call("DELETE", `/tenant-members/${created.memberId}`, { ifMatch: await currentEtag(created.memberId) });
    expect(removed.status).toBe(204);

    expect(await store.find(hash, NOW)).toBeNull();
    expect(await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_sessions").first("n")).toBe(0);
    expect(await real.db.prepare("SELECT active FROM portal_tenant_members WHERE member_id = ?").bind(created.memberId).first("active")).toBe(0);
    expect((await (await call("GET", "/tenant-members")).json() as { items: unknown[] }).items).toEqual([]);

    const readded = await add();
    expect(readded.principalId).not.toBe(created.principalId);
  });

  it("revokes every session of a member without removing it", async () => {
    const created = await add();
    const { store, hash } = await bindAndSignIn(created.memberId);
    const response = await call("POST", `/tenant-members/${created.memberId}/session-revocations`);
    expect(response.status).toBe(204);
    expect(await store.find(hash, NOW)).toBeNull();
    expect(await real.db.prepare("SELECT active FROM portal_tenant_members WHERE member_id = ?").bind(created.memberId).first("active")).toBe(1);
    expect(await real.db.prepare("SELECT COUNT(*) AS n FROM portal_admin_audit WHERE action = 'tenant_member.sessions_revoked'").first("n")).toBe(1);
  });

  it("answers 404 for an unknown or already removed member", async () => {
    expect((await call("POST", "/tenant-members/missing/session-revocations")).status).toBe(404);
    expect((await call("DELETE", "/tenant-members/missing", { ifMatch: `"sha256-${"a".repeat(43)}"` })).status).toBe(404);
  });

  it("writes nothing for an administrator whose session was revoked", async () => {
    await real.db.prepare("UPDATE portal_session_families SET revoked_at = ?").bind(NOW).run();
    const response = await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "a@example.com" } });
    expect(response.status).toBe(403);
    expect(await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_members").first("n")).toBe(0);
  });

  it("answers 403 without writing when the administrator's authority is revoked between the read and the batch", async () => {
    const created = await add();
    const { store, hash } = await bindAndSignIn(created.memberId);
    const etag = await currentEtag(created.memberId);
    const racingHandle = createTenantMembersHttp(new D1TenantMemberRepository(interleaved(real.db, async () => {
      await real.db.prepare("UPDATE portal_session_families SET revoked_at = ?").bind(NOW).run();
    }), () => NOW));
    const response = await racingHandle(new Request(`${ORIGIN}/admin/api/v1/tenant-members/${created.memberId}`, {
      method: "DELETE", headers: { "idempotency-key": "race", "if-match": etag },
    }), admin, "req-race");
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("forbidden");
    expect(await real.db.prepare("SELECT active FROM portal_tenant_members WHERE member_id = ?").bind(created.memberId).first("active")).toBe(1);
    expect(await store.find(hash, NOW)).not.toBeNull();
  });

  it("refuses a body with extra fields or a non-JSON content type", async () => {
    expect((await call("POST", "/tenant-members", { body: { tenantId: "t1", email: "a@example.com", role: "owner" } })).status).toBe(400);
    const text = await handle(new Request(`${ORIGIN}/admin/api/v1/tenant-members`, {
      method: "POST", headers: { "idempotency-key": "k", "content-type": "text/plain" }, body: "{}",
    }), admin, "req");
    expect(text.status).toBe(400);
  });
});
