import { describe, expect, it, vi } from "vitest";
import type { PlatformRequest, PlatformResponse, PlatformTransport } from "@unidocs/tenant-portal-client";
import { createTenantPortalClient, PlatformError } from "@unidocs/tenant-portal-client";
import type { TenantSession } from "../src/session/bootstrap.js";
import { withSessionRefresh } from "../src/session/refresh-transport.js";

const unauthorized: PlatformResponse = {
  ok: false,
  error: { error: { code: "unauthorized", message: "session expired", requestId: "r-401" } },
};
const signedIn: TenantSession = { kind: "signed-in", tenantId: "t1", principalId: "p1" };

/** 前 n 次请求 401（模拟 session 中途过期），之后成功。 */
function expiringTransport(failures: number) {
  const seen: PlatformRequest[] = [];
  const transport: PlatformTransport = async (request) => {
    seen.push(request);
    if (seen.length <= failures) return unauthorized;
    return { ok: true, data: { documentId: "d1", name: "n", documentType: "markdown", currentVersionIdx: null, createdAt: "x" } };
  };
  return { transport, seen };
}

describe("withSessionRefresh", () => {
  it("401 → 重新取 session → 用同一个请求重试一次，成功就交回结果", async () => {
    const { transport, seen } = expiringTransport(1);
    const loadSession = vi.fn(async () => signedIn);
    const onSignedOut = vi.fn();
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: withSessionRefresh(transport, { tenantId: "t1", loadSession, onSignedOut }),
    });

    const document = await client.createDocument("key-1", { documentType: "markdown", name: "n" });

    expect(document.documentId).toBe("d1");
    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
    // 写请求重试沿用原 idempotency key，不会建出第二份。
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[1].idempotencyKey).toBe("key-1");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("重新取 session 发现已登出：不重试，显示登录提示，原请求照常报 unauthorized", async () => {
    const { transport, seen } = expiringTransport(1);
    const onSignedOut = vi.fn();
    const client = createTenantPortalClient({
      tenantId: "t1",
      transport: withSessionRefresh(transport, {
        tenantId: "t1", loadSession: async () => ({ kind: "signed-out" }), onSignedOut,
      }),
    });

    const error = await client.getDocument("d1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("unauthorized");
    expect(seen).toHaveLength(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("重新取 session 本身失败（网络/5xx）也显示登录提示，不重试", async () => {
    const { transport, seen } = expiringTransport(1);
    const onSignedOut = vi.fn();
    const wrapped = withSessionRefresh(transport, {
      tenantId: "t1", loadSession: async () => { throw new Error("offline"); }, onSignedOut,
    });

    expect(await wrapped({ method: "GET", path: "/x" })).toEqual(unauthorized);
    expect(seen).toHaveLength(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("新 session 属于另一个 tenant：不拿旧 tenant 的路径重试，显示登录提示", async () => {
    const { transport, seen } = expiringTransport(1);
    const onSignedOut = vi.fn();
    const wrapped = withSessionRefresh(transport, {
      tenantId: "t1", loadSession: async () => ({ kind: "signed-in", tenantId: "t2", principalId: "p" }), onSignedOut,
    });

    expect(await wrapped({ method: "GET", path: "/x" })).toEqual(unauthorized);
    expect(seen).toHaveLength(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("只重试一次：重试仍 401 就显示登录提示，不无限循环", async () => {
    const { transport, seen } = expiringTransport(5);
    const loadSession = vi.fn(async () => signedIn);
    const onSignedOut = vi.fn();
    const wrapped = withSessionRefresh(transport, { tenantId: "t1", loadSession, onSignedOut });

    expect(await wrapped({ method: "GET", path: "/x" })).toEqual(unauthorized);
    expect(seen).toHaveLength(2);
    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("同时过期的多个请求共用一次 session 刷新", async () => {
    let calls = 0;
    const transport: PlatformTransport = async () => {
      calls += 1;
      return calls <= 2 ? unauthorized : { ok: true, data: {} };
    };
    const loadSession = vi.fn(async () => signedIn);
    const wrapped = withSessionRefresh(transport, { tenantId: "t1", loadSession, onSignedOut: () => {} });

    const results = await Promise.all([wrapped({ method: "GET", path: "/a" }), wrapped({ method: "GET", path: "/b" })]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(loadSession).toHaveBeenCalledTimes(1);
  });

  it("非 401 的失败原样交回，不碰 session", async () => {
    const forbidden: PlatformResponse = { ok: false, error: { error: { code: "forbidden", message: "x", requestId: "r" } } };
    const loadSession = vi.fn(async () => signedIn);
    const wrapped = withSessionRefresh(async () => forbidden, { tenantId: "t1", loadSession, onSignedOut: () => {} });

    expect(await wrapped({ method: "GET", path: "/x" })).toEqual(forbidden);
    expect(loadSession).not.toHaveBeenCalled();
  });
});
