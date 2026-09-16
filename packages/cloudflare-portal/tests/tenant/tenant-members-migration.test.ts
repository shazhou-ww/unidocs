import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRealD1, type RealD1 } from "./real-d1.js";

let real: RealD1;
beforeEach(async () => { real = await startRealD1(); });
afterEach(async () => { await real.dispose(); });

const insert = (values: { id: string; tenant?: string; principal: string; email: string; active?: number; issuer?: string | null; subject?: string | null }) =>
  real.db.prepare(`INSERT INTO portal_tenant_members
    (member_id, tenant_id, principal_id, email, issuer, subject, active, added_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'test', 1, 1)`)
    .bind(values.id, values.tenant ?? "t1", values.principal, values.email, values.issuer ?? null, values.subject ?? null, values.active ?? 1)
    .run();

describe("0015_tenant_members (real D1)", () => {
  it("allows one active membership per email, and reuse after deactivation", async () => {
    await insert({ id: "m1", principal: "user:1", email: "a@example.com" });
    await expect(insert({ id: "m2", tenant: "t2", principal: "user:2", email: "a@example.com" })).rejects.toThrow();
    await real.db.prepare("UPDATE portal_tenant_members SET active = 0 WHERE member_id = 'm1'").run();
    await expect(insert({ id: "m2", tenant: "t2", principal: "user:2", email: "a@example.com" })).resolves.toBeDefined();
  });

  it("allows one active membership per Google identity", async () => {
    await insert({ id: "m1", principal: "user:1", email: "a@example.com", issuer: "https://accounts.google.com", subject: "s" });
    await expect(insert({ id: "m2", tenant: "t2", principal: "user:2", email: "b@example.com", issuer: "https://accounts.google.com", subject: "s" })).rejects.toThrow();
  });

  it("requires issuer and subject together, and a boolean active flag", async () => {
    await expect(insert({ id: "m1", principal: "user:1", email: "a@example.com", issuer: "https://accounts.google.com" })).rejects.toThrow();
    await expect(insert({ id: "m1", principal: "user:1", email: "a@example.com", active: 2 })).rejects.toThrow();
  });

  it("never reuses a principal inside a tenant, even for an inactive row", async () => {
    await insert({ id: "m1", principal: "user:1", email: "a@example.com", active: 0 });
    await expect(insert({ id: "m2", principal: "user:1", email: "b@example.com" })).rejects.toThrow();
  });

  it("bounds a login transaction to ten minutes", async () => {
    const put = (expires: number) => real.db.prepare(
      "INSERT INTO portal_tenant_login_transactions VALUES ('s', 'b', 'v', 'n', '/portal/', 1000, ?)",
    ).bind(expires).run();
    await expect(put(1601)).rejects.toThrow();
    await expect(put(1600)).resolves.toBeDefined();
  });

  it("only accepts known auth audit actions for an existing member", async () => {
    await insert({ id: "m1", principal: "user:1", email: "a@example.com" });
    const audit = (member: string, action: string) => real.db.prepare(
      "INSERT INTO portal_tenant_auth_audit VALUES (?, ?, ?, 1, 'req')",
    ).bind(crypto.randomUUID(), member, action).run();
    await expect(audit("m1", "session.created")).resolves.toBeDefined();
    await expect(audit("m1", "session.stolen")).rejects.toThrow();
    await expect(audit("missing", "session.created")).rejects.toThrow();
  });
});
