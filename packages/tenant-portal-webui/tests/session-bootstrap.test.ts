import { describe, expect, it, vi } from "vitest";
import { describeConnectionFailure, loadTenantSession, signOut, TenantSessionError } from "../src/session/bootstrap.js";

describe("loadTenantSession", () => {
  it("returns the tenant identity when signed in", async () => {
    const session = await loadTenantSession(async () => Response.json({ tenantId: "t-local", principalId: "user-local" }));
    expect(session).toEqual({ kind: "signed-in", tenantId: "t-local", principalId: "user-local" });
  });

  it("reports signed-out on 401", async () => {
    const session = await loadTenantSession(async () => Response.json({ error: { code: "unauthorized", message: "x", requestId: "r" } }, { status: 401 }));
    expect(session).toEqual({ kind: "signed-out" });
  });

  it("requests the session with credentials", async () => {
    let seen: RequestInit | undefined;
    await loadTenantSession(async (_input, init) => { seen = init; return Response.json({ tenantId: "t", principalId: "p" }); });
    expect(seen?.credentials).toBe("include");
  });

  it("throws on an unexpected response rather than guessing a tenant", async () => {
    await expect(loadTenantSession(async () => Response.json({ tenantId: 42 }))).rejects.toThrow();
  });

  // Finding 1（终审）：403（origin 不是 loopback）、500（迁移没跑）……main.tsx 要能报出
  // 状态码，前提是抛出的错误真的带着它。
  it("throws a TenantSessionError carrying the HTTP status on a 403", async () => {
    const error = await loadTenantSession(async () =>
      Response.json({ error: { code: "forbidden", message: "x", requestId: "r" } }, { status: 403 }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TenantSessionError);
    expect((error as TenantSessionError).status).toBe(403);
  });

  it("throws a TenantSessionError carrying the HTTP status on a 500", async () => {
    const error = await loadTenantSession(async () => new Response("boom", { status: 500 }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TenantSessionError);
    expect((error as TenantSessionError).status).toBe(500);
  });
});

describe("describeConnectionFailure", () => {
  it("includes the HTTP status when the error carries one", () => {
    expect(describeConnectionFailure(new TenantSessionError("x", 403))).toEqual({ title: "无法连接到服务（HTTP 403）" });
  });

  it("falls back to a generic message for a network error with no status", () => {
    expect(describeConnectionFailure(new TypeError("Failed to fetch"))).toEqual({ title: "无法连接到服务" });
  });

  it("falls back to a generic message when the error is not even an Error", () => {
    expect(describeConnectionFailure("nope")).toEqual({ title: "无法连接到服务" });
  });
});

describe("signOut", () => {
  it("posts to the logout endpoint with the CSRF token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await signOut(fetchImpl, "csrf-token");
    expect(fetchImpl).toHaveBeenCalledWith("/portal/auth/logout", { method: "POST", credentials: "include", headers: { "x-csrf-token": "csrf-token" } });
  });

  it("treats an already ended session as signed out", async () => {
    await expect(signOut(async () => Response.json({ error: { code: "unauthorized" } }, { status: 401 }), "t")).resolves.toBeUndefined();
  });

  it("reports any other failure with its status", async () => {
    const error = await signOut(async () => new Response(null, { status: 403 }), null).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantSessionError);
    expect((error as TenantSessionError).status).toBe(403);
  });
});
