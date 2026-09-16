import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TenantAccessError } from "@unidocs/portal-service";
import {
  authenticateTenant,
  D1TenantSessionStore,
  TENANT_CSRF_COOKIE,
  TENANT_SESSION_COOKIE,
  TENANT_SESSION_TTL_SECONDS,
} from "../../src/tenant/session.js";
import { hashSessionSecret } from "../../src/auth.js";
import { insertMember } from "./members.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const NOW = 1_757_808_000;
const AGENT_TOKEN = "agent-local-token-0123456789";

let real: RealD1;
let store: D1TenantSessionStore;

beforeEach(async () => {
  real = await startRealD1();
  store = new D1TenantSessionStore(real.db);
  await insertMember(real.db, { tenantId: "t-local", principalId: "user-local", memberId: "member-user-local" });
});

afterEach(async () => {
  await real.dispose();
});

function request(options: { method?: string; token?: string; csrf?: string; origin?: string; authorization?: string; site?: string; url?: string } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("cookie", `${TENANT_SESSION_COOKIE}=${options.token}`);
  if (options.csrf) headers.set("x-csrf-token", options.csrf);
  if (options.origin) headers.set("origin", options.origin);
  if (options.authorization) headers.set("authorization", options.authorization);
  if (options.site) headers.set("sec-fetch-site", options.site);
  return new Request(options.url ?? `${ORIGIN}/api/v1/tenants/t-local/documents`, { method: options.method ?? "GET", headers });
}

describe("D1TenantSessionStore", () => {
  it("never stores the plaintext token", async () => {
    const { token, csrfToken } = await store.issue("t-local", "user-local", NOW);
    const { results } = await real.db.prepare("SELECT * FROM portal_tenant_sessions").all<Record<string, unknown>>();
    const stored = JSON.stringify(results);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(csrfToken);
  });

  it("does not find a session past its expiry", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const hash = await hashSessionSecret(token);
    expect(await store.find(hash, NOW + TENANT_SESSION_TTL_SECONDS - 1)).not.toBeNull();
    expect(await store.find(hash, NOW + TENANT_SESSION_TTL_SECONDS)).toBeNull();
  });

  it("does not find a revoked session", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const hash = await hashSessionSecret(token);
    await store.revoke(hash, "req-revoke", NOW);
    expect(await store.find(hash, NOW)).toBeNull();
  });

  it("does not find a session created after now", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW + 60);
    const hash = await hashSessionSecret(token);
    expect(await store.find(hash, NOW)).toBeNull();
    expect(await store.find(hash, NOW + 60)).not.toBeNull();
  });

  it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 1])("refuses to issue with the clock %s", async now => {
    await expect(store.issue("t-local", "user-local", now)).rejects.toBeInstanceOf(TypeError);
    const row = await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_sessions").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("finds no session once its member is deactivated", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const hash = await hashSessionSecret(token);
    expect(await store.find(hash, NOW)).not.toBeNull();
    await real.db.prepare("UPDATE portal_tenant_members SET active = 0 WHERE member_id = 'member-user-local'").run();
    expect(await store.find(hash, NOW)).toBeNull();
  });

  it("finds no session for a member who never bound a Google identity", async () => {
    await insertMember(real.db, { tenantId: "t-local", principalId: "user:invited", bound: false });
    const { token } = await store.issue("t-local", "user:invited", NOW);
    expect(await store.find(await hashSessionSecret(token), NOW)).toBeNull();
  });

  it("finds no session for a principal with no member row", async () => {
    const { token } = await store.issue("t-local", "user:stranger", NOW);
    expect(await store.find(await hashSessionSecret(token), NOW)).toBeNull();
  });

  it("audits a revocation against the member and deletes the row", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const hash = await hashSessionSecret(token);
    await store.revoke(hash, "req-logout", NOW);
    expect(await store.find(hash, NOW)).toBeNull();
    const audit = await real.db.prepare("SELECT member_id, action, occurred_at, request_id FROM portal_tenant_auth_audit").all();
    expect(audit.results).toEqual([{ member_id: "member-user-local", action: "session.revoked", occurred_at: NOW, request_id: "req-logout" }]);
  });

  it("takes over an existing member row at its natural key, making it canonical, when issuing a dev session", async () => {
    // beforeEach already seeded "member-user-local" at (t-local, user-local)
    // with its own generated email — a different member_id and a different
    // email than the dev session's. That row IS the dev member per spec
    // §4.4: issueDevSession must make it canonical rather than leaving it
    // untouched or failing on the natural-key collision.
    const before = await real.db.prepare("SELECT member_id, email FROM portal_tenant_members WHERE tenant_id = 't-local' AND principal_id = 'user-local'").first<{ member_id: string; email: string }>();
    expect(before?.member_id).toBe("member-user-local");
    expect(before?.email).not.toBe("dev@unidocs.local");

    const { token } = await store.issueDevSession(NOW);

    const rows = await real.db.prepare("SELECT member_id, tenant_id, principal_id, email, issuer, subject, active, added_by FROM portal_tenant_members WHERE tenant_id = 't-local' AND principal_id = 'user-local'").all();
    expect(rows.results).toEqual([{
      member_id: "member-user-local", tenant_id: "t-local", principal_id: "user-local",
      email: "dev@unidocs.local", issuer: "local-dev", subject: "user-local", active: 1, added_by: "dev-session",
    }]);
    expect(await store.find(await hashSessionSecret(token), NOW)).toMatchObject({ tenantId: "t-local", principalId: "user-local" });
  });

  it("issues a dev session that brings its own member row, and is idempotent about it", async () => {
    await real.db.prepare("DELETE FROM portal_tenant_members").run();
    const first = await store.issueDevSession(NOW);
    const second = await store.issueDevSession(NOW + 1);
    expect(await store.find(await hashSessionSecret(first.token), NOW + 1)).toMatchObject({ tenantId: "t-local", principalId: "user-local" });
    expect(await store.find(await hashSessionSecret(second.token), NOW + 1)).not.toBeNull();
    const members = await real.db.prepare("SELECT member_id, email, issuer, subject, active, added_by FROM portal_tenant_members").all();
    expect(members.results).toEqual([{ member_id: "member-local-dev", email: "dev@unidocs.local", issuer: "local-dev", subject: "user-local", active: 1, added_by: "dev-session" }]);
    expect((await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_auth_audit").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("authenticateTenant", () => {
  const auth = (req: Request) => authenticateTenant(req, { origin: ORIGIN, now: NOW, store });
  const agentAuth = (req: Request) => authenticateTenant(req, { origin: ORIGIN, now: NOW, store, agentToken: AGENT_TOKEN, agentTenantId: "t-agent" });

  it("resolves a valid session on a read", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ token }))).resolves.toMatchObject({
      tenantId: "t-local", principalId: "user-local", transport: "session",
    });
  });

  it("is unauthorized without a session cookie", async () => {
    await expect(auth(request())).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does not fall back to a valid cookie when an Authorization header is present", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ token, authorization: "Bearer abc.def.ghi" }))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does not fall back to a valid cookie when the Agent bearer token is wrong", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(agentAuth(request({ token, authorization: `Bearer ${AGENT_TOKEN}x` }))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does not fall back to a valid cookie when no Agent token is configured", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const unconfigured = authenticateTenant(request({ token, authorization: `Bearer ${AGENT_TOKEN}` }), {
      origin: ORIGIN, now: NOW, store, agentToken: undefined, agentTenantId: "t-agent",
    });
    await expect(unconfigured).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("resolves the Agent bearer token to a bearer context without reading the cookie or the session store", async () => {
    const untouched = { find: async () => { throw new Error("session store must not be read"); } } as unknown as D1TenantSessionStore;
    const context = await authenticateTenant(request({ token: "not-even-a-valid-cookie", authorization: `Bearer ${AGENT_TOKEN}` }), {
      origin: ORIGIN, now: NOW, store: untouched, agentToken: AGENT_TOKEN, agentTenantId: "t-agent",
    });
    expect(context).toEqual({
      tenantId: "t-agent",
      principalId: "agent:markdown-primary",
      transport: "bearer",
      scopes: ["documents:read", "comments:read", "comments:reply", "versions:submit"],
    });
  });

  it("accepts an Agent bearer mutation with no Origin or CSRF token", async () => {
    await expect(agentAuth(request({ method: "POST", authorization: `Bearer ${AGENT_TOKEN}` }))).resolves.toMatchObject({ transport: "bearer" });
  });

  it("does not resolve a session whose created_at is in the future", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW + 60);
    await expect(auth(request({ token }))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 1])("throws TypeError for the clock %s", async now => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(authenticateTenant(request({ token }), { origin: ORIGIN, now, store })).rejects.toBeInstanceOf(TypeError);
    await expect(authenticateTenant(request({ authorization: `Bearer ${AGENT_TOKEN}` }), {
      origin: ORIGIN, now, store, agentToken: AGENT_TOKEN, agentTenantId: "t-agent",
    })).rejects.toBeInstanceOf(TypeError);
  });

  it("refuses a cross-site request even with a valid session", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ token, site: "cross-site" }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a mutation without a CSRF token", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ method: "POST", token, origin: ORIGIN }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a mutation whose CSRF token does not match", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const { csrfToken: other } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ method: "POST", token, csrf: other, origin: ORIGIN }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a mutation from another origin even with a matching CSRF token", async () => {
    const { token, csrfToken } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ method: "POST", token, csrf: csrfToken, origin: "http://evil.test" }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("accepts a mutation with a matching CSRF token and origin", async () => {
    const { token, csrfToken } = await store.issue("t-local", "user-local", NOW);
    await expect(auth(request({ method: "POST", token, csrf: csrfToken, origin: ORIGIN }))).resolves.toMatchObject({ tenantId: "t-local" });
  });

  it("throws TenantAccessError, so the HTTP layer can map it", async () => {
    await expect(auth(request())).rejects.toBeInstanceOf(TenantAccessError);
  });

  it("refuses a cross-site request with no cookie as forbidden, not unauthorized", async () => {
    await expect(auth(request({ site: "cross-site" }))).rejects.toMatchObject({ code: "forbidden" });
  });
});
