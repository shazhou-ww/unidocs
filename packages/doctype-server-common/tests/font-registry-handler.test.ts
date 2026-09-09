/**
 * /tenants/{t}/fonts 的中立处理器。
 *
 * 鉴权规则从 cloudflare-psd/src/fonts-do.ts 的 authenticateFontsRoute 逐条
 * 搬来,一条都不放松 —— 尤其"只接受 sessions:create 这一种权限"和"拒绝委派的
 * CAS 权限"(R29:这个端点背后不碰 CAS,多带一份权柄是调用方搞错了)。
 */
import { describe, expect, it } from "vitest";
import { handleFontsRequest } from "../src/font-registry-handler.js";
import { createMemoryFontProvider } from "../src/memory-ports.js";
import { createFontRegistry } from "../src/font-registry.js";
import type { FontEntry } from "../src/font-registry.js";
import type { FontProvider } from "../src/font-provider.js";

const TENANT = "t1";
const entry: FontEntry = {
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: "a".repeat(64),
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e]],
};

/** 只认一个 token 的假校验器,形状与 DocCapabilityVerifier 一致。 */
function verifierAccepting(permissions: readonly string[]) {
  return verifierWithClaims({ sub: "gateway", tenantId: TENANT, permissions });
}

/** `verifierAccepting` 的一般形式:sub / tenantId 也可控,用于鉴权边界测试。 */
function verifierWithClaims(claims: {
  readonly sub: string;
  readonly tenantId: string;
  readonly permissions: readonly string[];
}) {
  return {
    async verify(token: string) {
      if (token !== "good") throw new Error("bad token");
      return {
        protectedHeader: { kid: "kid-1" },
        claims: { ...claims, jti: "jti-1" },
      };
    },
  } as never;
}

/** 校验直接失败的假校验器 —— 用来测"verify 抛的不是 CapabilityError"这条分支。 */
function verifierThrowing(error: unknown) {
  return {
    async verify() {
      throw error;
    },
  } as never;
}

function req(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://svc/tenants/${TENANT}/fonts`, {
    method,
    headers: { Authorization: "Bearer good", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("handleFontsRequest", () => {
  const cfg = () => ({
    docCapabilityVerifier: verifierAccepting([`tenants:${TENANT}:sessions:create`]),
    provider: createMemoryFontProvider(),
  });

  it("GET 列出登记表", async () => {
    const c = cfg();
    await c.provider.put(entry);
    const res = await handleFontsRequest(c, req("GET"), { tenantId: TENANT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fonts: [entry] });
  });

  it("POST 登记一条,再 GET 能读回", async () => {
    const c = cfg();
    const res = await handleFontsRequest(c, req("POST", entry), { tenantId: TENANT });
    expect(res.status).toBe(200);
    expect(await c.provider.list()).toEqual([entry]);
  });

  it("GET 仍然只返回租户那一档,不掺内置字体", async () => {
    // 路由直接持有租户 provider,不经门面 —— 这个端点回答的是"这个租户**登记了**
    // 什么",不是"这个租户**能用**什么"。掺进内置字体会让 seed 脚本的幂等判据
    //("索引里有没有")每次都判成"已经有了",于是一套字体都灌不进去。
    const builtinEntry: FontEntry = {
      ...entry,
      postScriptName: "Builtin-Regular",
      family: "Builtin",
    };
    const builtin: FontProvider = {
      id: "builtin",
      list: async () => [builtinEntry],
      read: async () => { throw new Error("路由不读字节"); },
      blobFor: () => null,
    };
    const c = cfg();
    await c.provider.put(entry);
    // 先证明这条断言不是空转:门面确实会把内置那一档合进来。少了这一句,下面那条
    // "只有一条"在内置来源根本没生效时也照样绿。
    const merged = await createFontRegistry({ providers: [builtin, c.provider] }).index();
    expect([...merged.keys()]).toEqual([builtinEntry.postScriptName, entry.postScriptName]);

    const res = await handleFontsRequest(c, req("GET"), { tenantId: TENANT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fonts: [entry] });
  });

  it("方法不对回 405,不是 404 —— 别把\"方法用错\"说成\"端点不存在\"", async () => {
    const res = await handleFontsRequest(cfg(), req("DELETE"), { tenantId: TENANT });
    expect(res.status).toBe(405);
  });

  it("校验不过的载荷回 400 且不落库", async () => {
    const c = cfg();
    const res = await handleFontsRequest(c, req("POST", { ...entry, coverage: [] }), { tenantId: TENANT });
    expect(res.status).toBe(400);
    expect(await c.provider.list()).toEqual([]);
  });

  it("body 不是 JSON 回 400", async () => {
    const c = cfg();
    const bad = new Request(`https://svc/tenants/${TENANT}/fonts`, {
      method: "POST",
      headers: { Authorization: "Bearer good", "Content-Type": "application/json" },
      body: "{oops",
    });
    expect((await handleFontsRequest(c, bad, { tenantId: TENANT })).status).toBe(400);
  });

  it("权限不是租户级的 sessions:create 就拒 —— 索引是租户级的,会话权限与它无关", async () => {
    const c = {
      docCapabilityVerifier: verifierAccepting([`tenants:${TENANT}:sessions:s1:write`]),
      provider: createMemoryFontProvider(),
    };
    expect((await handleFontsRequest(c, req("GET"), { tenantId: TENANT })).status).toBe(403);
  });

  it("权限是必需权限的超集也拒 —— 照妖镜:若生产代码从严格相等改成 includes(),这条会先变绿", async () => {
    const c = {
      docCapabilityVerifier: verifierAccepting([
        `tenants:${TENANT}:sessions:create`,
        `tenants:${TENANT}:cas:read`,
      ]),
      provider: createMemoryFontProvider(),
    };
    expect((await handleFontsRequest(c, req("GET"), { tenantId: TENANT })).status).toBe(403);
  });

  it("权限为空数组也拒", async () => {
    const c = {
      docCapabilityVerifier: verifierAccepting([]),
      provider: createMemoryFontProvider(),
    };
    expect((await handleFontsRequest(c, req("GET"), { tenantId: TENANT })).status).toBe(403);
  });

  it("claims.sub 不是 gateway 就拒(401)", async () => {
    const c = {
      docCapabilityVerifier: verifierWithClaims({
        sub: "some-user",
        tenantId: TENANT,
        permissions: [`tenants:${TENANT}:sessions:create`],
      }),
      provider: createMemoryFontProvider(),
    };
    expect((await handleFontsRequest(c, req("GET"), { tenantId: TENANT })).status).toBe(401);
  });

  it("claims.tenantId 与路径里的租户不符就拒(403)", async () => {
    const c = {
      docCapabilityVerifier: verifierWithClaims({
        sub: "gateway",
        tenantId: "other-tenant",
        permissions: [`tenants:${TENANT}:sessions:create`],
      }),
      provider: createMemoryFontProvider(),
    };
    expect((await handleFontsRequest(c, req("GET"), { tenantId: TENANT })).status).toBe(403);
  });

  it("不带 Authorization 头就拒(401)", async () => {
    const c = cfg();
    const noAuth = new Request(`https://svc/tenants/${TENANT}/fonts`, { method: "GET" });
    expect((await handleFontsRequest(c, noAuth, { tenantId: TENANT })).status).toBe(401);
  });

  it("token 校验抛出普通 Error(非 CapabilityError)也回 401,不是把服务端异常透出", async () => {
    const c = {
      docCapabilityVerifier: verifierThrowing(new Error("network exploded")),
      provider: createMemoryFontProvider(),
    };
    expect((await handleFontsRequest(c, req("GET"), { tenantId: TENANT })).status).toBe(401);
  });

  it("带了委派的 CAS 权限就拒 —— R29:这个端点不碰 CAS,多带一份权柄是调用方搞错了", async () => {
    const res = await handleFontsRequest(
      cfg(),
      req("GET", undefined, { "X-UniDocs-CAS-Capability": "whatever" }),
      { tenantId: TENANT },
    );
    expect(res.status).toBe(403);
  });

  it("审计事件报出 operation 与 tenantId,不含 token", async () => {
    const events: unknown[] = [];
    await handleFontsRequest(
      { ...cfg(), audit: e => events.push(e) },
      req("GET"),
      { tenantId: TENANT },
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain("listFonts");
    expect(JSON.stringify(events[0])).not.toContain("good");
  });
});
