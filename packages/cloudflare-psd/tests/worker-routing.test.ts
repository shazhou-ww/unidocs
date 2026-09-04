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
 *
 * 文件末尾另有一组"真凭据打穿鉴权"的端到端用例，钉住 `worker.ts` fetch 分支
 * 里那层顶层 try/catch：中立的 `handleFontsRequest` 不兜底
 * `registry.list/put` 抛出的异常，这层 catch 是把存储故障变成 500、而不是
 * 未处理拒绝的唯一屏障。照 `doctype-server-common` 的
 * `tests/doc-auth-config.test.ts` 的做法，用 `jose` 现场造一对真密钥、签一张
 * 真 capability——`authConfig` 是 `worker.ts` 里的模块级单例，第一次
 * `authConfig.get(env)` 就把 `CAPABILITY_TRUSTED_JWKS` 建好的校验器缓存住、
 * 此后不再看传进来的 env，所以这把真密钥必须从模块顶部的共享 `env` 就开始用
 * ——不能等到最后那组用例才现造一份不同的 JWKS，那样会被前面已经建好的缓存
 * 校验器拒掉（认不出新的 kid）。文件里其余用例都停在鉴权之前（没带
 * Authorization、方法不对等），不关心这把密钥是真是假，所以换成真密钥不影响
 * 它们。
 */
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  CapabilityAlgorithm,
  CapabilityIssuer,
  JoseCapabilitySigner,
  sessionCreatePermission,
} from "@unidocs/service-auth";
import worker, { PsdEditor, PsdFonts, PsdOperator } from "../src/worker.js";

const ISSUER = "https://issuer.example";
const DOC_AUDIENCE = "unidocs-doc:psd";
/** CAS 校验器也得建得起来（`resolveDocAuthConfig` 两个都建），但本文件不
 *  验证任何 CAS 凭据，格式对、内容假都无所谓。 */
const CAS_JWKS = JSON.stringify({ keys: [{ kid: "k1", kty: "EC", crv: "P-256", x: "x", y: "y" }] });

const docKeyPair = await generateKeyPair(CapabilityAlgorithm, { extractable: true });
const docPublicJwk = await exportJWK(docKeyPair.publicKey);
const DOC_JWKS = JSON.stringify({
  keys: [{ ...docPublicJwk, kid: "doc-key", alg: CapabilityAlgorithm }],
});
const docIssuer = new CapabilityIssuer({
  issuer: ISSUER,
  signer: new JoseCapabilitySigner(docKeyPair.privateKey, "doc-key"),
});
/**
 * 签一张字体端点认的凭据：租户级、恰好一条 `sessions:create` 权限。
 *
 * 字体索引本身不看 `sessionId`（它是租户级的），但 `CapabilityIssuer.issue`
 * 的 `validatePermissionSet` 要求任何 `sessions:*` 权限的凭据必须带
 * `sessionId`（`issuer.ts`），所以这里现编一个占位值——不指向任何真实会话，
 * `handleFontsRequest`/`authenticateFontsRoute` 也不会读它。同一招
 * `scripts/seed-psd-fonts.mjs` 的 `createDocTokenFactory` 已经在用。
 */
const signFontsToken = (tenantId: string): Promise<string> => docIssuer.issue({
  subject: "gateway",
  audience: DOC_AUDIENCE,
  tenantId,
  sessionId: `test-session-${crypto.randomUUID()}`,
  permissions: [sessionCreatePermission(tenantId)],
});

/** 够 `resolveDocAuthConfig` 跑通的最小 env；`CAPABILITY_TRUSTED_JWKS` 是上面
 *  这把真密钥的公钥——多数用例不带 Authorization、用不上它，文件末尾的端到端
 *  用例用得上。 */
const env = {
  CAPABILITY_ISSUER: ISSUER,
  CAPABILITY_TRUSTED_JWKS: DOC_JWKS,
  DOC_CAPABILITY_AUDIENCE: DOC_AUDIENCE,
  CAS_CAPABILITY_AUDIENCE: "unidocs-cas",
  CAS_STACK_ID: "cas_1",
  CAS_STACK_ISSUER: "https://issuer.example/cas",
  CAS_STACK_TRUSTED_JWKS: CAS_JWKS,
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

/**
 * 真凭据打穿鉴权，落到 registry 这一层——不是靠"没带 Authorization"停在
 * 鉴权之前。两条用例共享同一张签好的凭据，唯一变量是 `PSD_FONTS` 是否健康：
 * 健康时证明这条链路本身是通的（不是别的原因导致后面那条 500），故障时证明
 * `worker.ts` fetch 分支里那层 try/catch 真的把存储异常接成了 500，而不是
 * 变成一个未处理的 Promise rejection。
 */
describe("worker.fetch 的字体端点：真凭据端到端", () => {
  it("PSD_FONTS 正常时，真凭据请求拿到 200", async () => {
    const token = await signFontsToken("alice");
    const response = await fetchWorker("/tenants/alice/fonts", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ fonts: [] });
  });

  it("PSD_FONTS 存储故障（DO stub 的 fetch 直接抛）时，真凭据请求拿到 500，不是未处理拒绝", async () => {
    const token = await signFontsToken("alice");
    const failingEnv = {
      ...env,
      PSD_FONTS: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () => {
            throw new Error("storage unavailable");
          },
        }),
      },
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(
      new Request("http://psd.local/tenants/alice/fonts", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      failingEnv,
    );
    expect(response.status).toBe(500);
  });
});
