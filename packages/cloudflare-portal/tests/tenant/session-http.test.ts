import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1TenantSessionStore, TENANT_CSRF_COOKIE, TENANT_SESSION_COOKIE } from "../../src/tenant/session.js";
import { createTenantSessionHttp } from "../../src/tenant/session-http.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const LOCAL = "http://127.0.0.1:8795";
const PRODUCTION = "https://unidocs.shazhou.work";
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

async function sessionRows() {
  const row = await real.db.prepare("SELECT COUNT(*) AS n FROM portal_tenant_sessions").first<{ n: number }>();
  return row?.n ?? 0;
}

function cookieValue(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [key, value] = pair.split("=");
    if (key === name) return value;
  }
  return null;
}

describe("GET /portal/auth/session", () => {
  it("issues a local session on a loopback origin when none exists", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`), "req-1");
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ tenantId: "t-local", principalId: "user-local" });
    expect(cookieValue(response!, TENANT_SESSION_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieValue(response!, TENANT_CSRF_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sessionRows()).toBe(1);
  });

  it("marks the session cookie HttpOnly and leaves the CSRF cookie readable", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`), "req-1");
    const headers = response!.headers.getSetCookie();
    const session = headers.find(value => value.startsWith(`${TENANT_SESSION_COOKIE}=`))!;
    const csrf = headers.find(value => value.startsWith(`${TENANT_CSRF_COOKIE}=`))!;
    expect(session).toContain("HttpOnly");
    expect(csrf).not.toContain("HttpOnly");
  });

  it("never issues a session on a non-loopback origin", async () => {
    const handle = createTenantSessionHttp({ origin: PRODUCTION, store, now: () => NOW });
    const response = await handle(new Request(`${PRODUCTION}/portal/auth/session`), "req-1");
    expect(response?.status).toBe(401);
    expect(response!.headers.getSetCookie()).toEqual([]);
    expect(await sessionRows()).toBe(0);
  });

  it("reuses an existing session instead of issuing another", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const first = await handle(new Request(`${LOCAL}/portal/auth/session`), "req-1");
    const token = cookieValue(first!, TENANT_SESSION_COOKIE)!;
    const second = await handle(new Request(`${LOCAL}/portal/auth/session`, {
      headers: { cookie: `${TENANT_SESSION_COOKIE}=${token}` },
    }), "req-2");
    expect(second?.status).toBe(200);
    expect(second!.headers.getSetCookie()).toEqual([]);
    expect(await sessionRows()).toBe(1);
  });

  it("does not issue on a cross-site request", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`, {
      headers: { "sec-fetch-site": "cross-site" },
    }), "req-1");
    expect(response?.status).toBe(403);
    expect(await sessionRows()).toBe(0);
  });

  it("does not issue when an Authorization header is present on loopback", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`, {
      headers: { authorization: "Bearer x" },
    }), "req-1");
    expect(response?.status).toBe(401);
    expect(response!.headers.getSetCookie()).toEqual([]);
    expect(await sessionRows()).toBe(0);
  });

  it("does not issue for a mismatched request URL origin even with an Authorization header", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request("http://evil.test:8795/portal/auth/session", {
      headers: { authorization: "Bearer x" },
    }), "req-1");
    expect(response?.status).not.toBe(200);
    expect(response!.headers.getSetCookie()).toEqual([]);
    expect(await sessionRows()).toBe(0);
  });

  it("does not issue for a cross-site request even with an Authorization header", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/session`, {
      headers: { authorization: "Bearer x", "sec-fetch-site": "cross-site" },
    }), "req-1");
    expect(response?.status).not.toBe(200);
    expect(response!.headers.getSetCookie()).toEqual([]);
    expect(await sessionRows()).toBe(0);
  });

  it("returns null for a path it does not own", async () => {
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    await expect(handle(new Request(`${LOCAL}/api/v1/tenants/t-local/documents`), "req-1")).resolves.toBeNull();
  });
});

describe("POST /portal/auth/logout", () => {
  it("revokes the session and clears both cookies", async () => {
    const { token, csrfToken } = await store.issue("t-local", "user-local", NOW);
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/logout`, {
      method: "POST",
      headers: { cookie: `${TENANT_SESSION_COOKIE}=${token}`, "x-csrf-token": csrfToken, origin: LOCAL },
    }), "req-1");
    expect(response?.status).toBe(204);
    const headers = response!.headers.getSetCookie();
    expect(headers).toHaveLength(2);
    expect(cookieValue(response!, TENANT_SESSION_COOKIE)).toBe("");
    expect(cookieValue(response!, TENANT_CSRF_COOKIE)).toBe("");
    const session = headers.find(value => value.startsWith(`${TENANT_SESSION_COOKIE}=`))!;
    const csrf = headers.find(value => value.startsWith(`${TENANT_CSRF_COOKIE}=`))!;
    expect(session).toContain("Max-Age=0");
    expect(csrf).toContain("Max-Age=0");
    expect(await sessionRows()).toBe(0);
  });

  it("refuses a logout without the CSRF token and leaves the session intact", async () => {
    const { token } = await store.issue("t-local", "user-local", NOW);
    const handle = createTenantSessionHttp({ origin: LOCAL, store, now: () => NOW });
    const response = await handle(new Request(`${LOCAL}/portal/auth/logout`, {
      method: "POST",
      headers: { cookie: `${TENANT_SESSION_COOKIE}=${token}`, origin: LOCAL },
    }), "req-1");
    expect(response?.status).toBe(403);
    expect(await sessionRows()).toBe(1);
  });
});
