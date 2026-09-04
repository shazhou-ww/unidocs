/**
 * worker 的分流：租户级 `/tenants/{t}/fonts` 走字体逻辑，其余一律照旧交给
 * `createDocTypeHandler`。
 *
 * 判据不用"响应内容对不对"，用**两个处理器答不出同一句话**这一点：
 * `matchDocRoute` 不认识 `/tenants/{t}/fonts`（它硬编码成
 * `/tenants/{t}/sessions/{s}[/{op}]`），分流一旦漏掉，这条路径的响应会变成
 * `createDocTypeHandler` 的 404 `Unknown Doc endpoint`。反过来，分流一旦写得
 * 太宽，会话级端点会得到字体处理器的 405/401，而不是 doc 边缘的鉴权错误。
 * 两个方向各有一条断言。
 */
import { describe, expect, it } from "vitest";
import worker, { PsdEditor, PsdFonts, PsdOperator } from "../src/worker.js";

const JWKS = JSON.stringify({ keys: [{ kid: "k1", kty: "EC", crv: "P-256", x: "x", y: "y" }] });

/** 够 `resolveDocAuthConfig` 跑通的最小 env；不签发任何真凭据。 */
const env = {
  CAPABILITY_ISSUER: "https://issuer.example",
  CAPABILITY_TRUSTED_JWKS: JWKS,
  DOC_CAPABILITY_AUDIENCE: "unidocs-doc:psd",
  CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
  CAS_STACK_ID: "cas_1",
  CAS_STACK_ISSUER: "https://issuer.example/cas",
  CAS_STACK_TRUSTED_JWKS: JWKS,
  CAPABILITY_ALGORITHM: "ES256",
  CAPABILITY_TTL_SECONDS: "120",
  CAPABILITY_MAX_LIFETIME_SECONDS: "1800",
  CAPABILITY_CLOCK_SKEW_SECONDS: "30",
  PSD_FONTS: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ fonts: [] }) }),
  },
} as unknown as Parameters<typeof worker.fetch>[1];

const fetchWorker = (path: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(new Request(`http://psd.local${path}`, init), env);

const errorOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error?: string }).error ?? "";

describe("worker 三个 DO 导出俱在", () => {
  it("PsdEditor / PsdOperator / PsdFonts 都是类", () => {
    for (const klass of [PsdEditor, PsdOperator, PsdFonts]) {
      expect(typeof klass).toBe("function");
    }
  });
});

describe("worker.fetch 的分流", () => {
  it("/tenants/{t}/fonts 走字体逻辑 —— 不是 doc 边缘的 Unknown Doc endpoint", async () => {
    const response = await fetchWorker("/tenants/alice/fonts");
    expect(response.status).toBe(401);
    expect(await errorOf(response)).not.toMatch(/Unknown Doc endpoint/);
  });

  it("字体路径上的怪方法由字体处理器回 405，不是 404", async () => {
    const response = await fetchWorker("/tenants/alice/fonts", { method: "DELETE" });
    expect(response.status).toBe(405);
  });

  it("会话级端点仍然走 createDocTypeHandler", async () => {
    for (const [path, init] of [
      ["/tenants/alice/sessions/s1", { method: "PUT" }],
      ["/tenants/alice/sessions/s1/export", undefined],
      ["/tenants/alice/sessions/s1/apply", { method: "POST" }],
      ["/tenants/alice/sessions/s1/run", { method: "POST" }],
    ] as const) {
      const response = await fetchWorker(path, init as RequestInit | undefined);
      // doc 边缘认得这条路由，卡在鉴权上 —— 不是"这个端点不存在"。
      expect(response.status, path).toBe(401);
      expect(await errorOf(response), path).toMatch(/Capability token is required/);
    }
  });

  it("既不是字体也不是会话的路径仍然是 doc 边缘的 404", async () => {
    const response = await fetchWorker("/healthz");
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toMatch(/Unknown Doc endpoint/);
  });

  it("PSD_FONTS 绑定缺失时说得出是没配，而不是 500", async () => {
    const { PSD_FONTS: _omitted, ...withoutFonts } = env as Record<string, unknown>;
    const response = await worker.fetch(
      new Request("http://psd.local/tenants/alice/fonts"),
      withoutFonts as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(501);
    expect(await errorOf(response)).toMatch(/not configured/);
  });
});
