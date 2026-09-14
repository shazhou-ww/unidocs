import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TenantAccessError } from "@unidocs/portal-service";
import {
  authenticateTenant,
  D1TenantSessionStore,
  TENANT_CSRF_COOKIE,
  TENANT_SESSION_COOKIE,
  TENANT_SESSION_TTL_SECONDS,
} from "../../src/tenant/session.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const NOW = 1_757_808_000;

let real: RealD1;
let store: D1TenantSessionStore;

beforeEach(async () => {
  real = await startRealD1();
  store = new D1TenantSessionStore(real.db);
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
    const { hashSessionSecret } = await import("../../src/auth.js");
    const hash = await hashSessionSecret(token);
    expect(await store.find(hash, NOW + TENANT_SESSION_TTL_SECONDS - 1)).not.toBeNull();
    expect(await store.find(hash, NOW + TENANT_SESSION_TTL_SECONDS)).toBeNull();
  });

  it("does not find a revoked session", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const { hashSessionSecret } = await import("../../src/auth.js");
    const hash = await hashSessionSecret(token);
    await store.revoke(hash);
    expect(await store.find(hash, NOW)).toBeNull();
  });
});

describe("authenticateTenant", () => {
  const auth = (req: Request) => authenticateTenant(req, { origin: ORIGIN, now: NOW, store });

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
