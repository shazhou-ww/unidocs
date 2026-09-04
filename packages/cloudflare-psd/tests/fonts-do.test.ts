/**
 * 字体索引 DO 与它的边缘处理。
 *
 * 这个包此前没有任何测试基建，也没有 `@cloudflare/vitest-pool-workers`。
 * DO 的 sqlite 用 `node:sqlite` 顶上：`ctx.storage.sql.exec` 的形状（可变位置
 * 绑定参数 + `.toArray()`）转发给一个内存 sqlite，语义是真的 SQL —— 主键、
 * `INSERT OR REPLACE`、`ORDER BY` 都不用假装。只在测试里用，运行时代码不碰
 * 任何 Node 内置模块。
 */
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  CapabilityAlgorithm,
  CapabilityTokenType,
  casReadPermission,
  sessionCreatePermission,
  sessionWritePermission,
} from "@unidocs/service-auth";
import type { CapabilityPermission, VerifiedCapability } from "@unidocs/service-auth";
import type { FontEntry } from "@unidocs/doctype-psd";
import {
  FONTS_INTERNAL_PATH,
  fontEntryProblem,
  fontsObjectName,
  handleFontsRequest,
  matchFontsRoute,
  PsdFontsDurableObject,
} from "../src/fonts-do.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** `ctx.storage.sql` 的形状，背后是一个真的内存 sqlite。 */
function fontsState(): DurableObjectState {
  const db = new DatabaseSync(":memory:");
  return {
    storage: {
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          const rows = db.prepare(query).all(...(bindings as never[]));
          return { toArray: () => rows };
        },
      },
    },
  } as unknown as DurableObjectState;
}

const entry = (overrides: Partial<FontEntry> = {}): FontEntry => ({
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: HASH_A,
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e], [0x4e00, 0x9fff]],
  ...overrides,
});

const get = (): Request => new Request(`http://fonts${FONTS_INTERNAL_PATH}`);
const post = (body: unknown): Request => new Request(`http://fonts${FONTS_INTERNAL_PATH}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("PsdFonts DO", () => {
  it("建表 → 登记两条 → 列出，字段逐一对上", async () => {
    const fonts = new PsdFontsDurableObject(fontsState());
    const latin = entry();
    const cjk = entry({
      postScriptName: "NotoSansSC-Regular",
      family: "Noto Sans SC",
      hash: HASH_B,
      unitsPerEm: 2048,
      coverage: [[0x3000, 0x30ff]],
    });

    expect((await fonts.fetch(post(latin))).status).toBe(200);
    expect((await fonts.fetch(post(cjk))).status).toBe(200);

    const listed = await (await fonts.fetch(get())).json() as { fonts: FontEntry[] };
    expect(listed.fonts).toEqual([latin, cjk]);
  });

  it("空索引返回空数组，不是 500 —— 表是第一次请求时建的", async () => {
    const fonts = new PsdFontsDurableObject(fontsState());
    const response = await fonts.fetch(get());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ fonts: [] });
  });

  it("同名登记两次只剩一条，且是后一条（INSERT OR REPLACE 的幂等）", async () => {
    const fonts = new PsdFontsDurableObject(fontsState());
    await fonts.fetch(post(entry()));
    const updated = entry({ hash: HASH_B, unitsPerEm: 2048, family: "Noto Sans v2" });
    await fonts.fetch(post(updated));

    const listed = await (await fonts.fetch(get())).json() as { fonts: FontEntry[] };
    expect(listed.fonts).toEqual([updated]);
  });

  it("认得的只有 /_internal/fonts —— 其他路径 404", async () => {
    const fonts = new PsdFontsDurableObject(fontsState());
    const response = await fonts.fetch(new Request("http://fonts/_internal/query"));
    expect(response.status).toBe(404);
  });

  it("方法不对回 405，不是静默当成 GET", async () => {
    const fonts = new PsdFontsDurableObject(fontsState());
    const response = await fonts.fetch(new Request(`http://fonts${FONTS_INTERNAL_PATH}`, {
      method: "DELETE",
    }));
    expect(response.status).toBe(405);
  });

  it("body 不是 JSON 时回 400", async () => {
    const fonts = new PsdFontsDurableObject(fontsState());
    const response = await fonts.fetch(new Request(`http://fonts${FONTS_INTERNAL_PATH}`, {
      method: "POST",
      body: "not json",
    }));
    expect(response.status).toBe(400);
  });

  it("校验不过的载荷不落库", async () => {
    const fonts = new PsdFontsDurableObject(fontsState());
    const response = await fonts.fetch(post(entry({ unitsPerEm: 0 })));
    expect(response.status).toBe(400);
    const listed = await (await fonts.fetch(get())).json() as { fonts: FontEntry[] };
    expect(listed.fonts).toEqual([]);
  });
});

describe("fontEntryProblem", () => {
  it("合法条目没有问题", () => {
    expect(fontEntryProblem(entry())).toBeNull();
  });

  it("unitsPerEm 非正 → 说得出是哪个字段", () => {
    expect(fontEntryProblem(entry({ unitsPerEm: 0 }))).toMatch(/unitsPerEm/);
    expect(fontEntryProblem(entry({ unitsPerEm: -1 }))).toMatch(/unitsPerEm/);
    expect(fontEntryProblem(entry({ unitsPerEm: 1000.5 }))).toMatch(/unitsPerEm/);
  });

  it("coverage 乱序 → 指名道姓说是第几条", () => {
    const problem = fontEntryProblem(entry({ coverage: [[0x4e00, 0x9fff], [0x20, 0x7e]] }));
    expect(problem).toMatch(/coverage\[1\]/);
    expect(problem).toMatch(/coverage\[0\]/);
  });

  it("coverage 重叠 → 400 的理由说得出重叠在哪", () => {
    const problem = fontEntryProblem(entry({ coverage: [[0x20, 0x100], [0x80, 0x200]] }));
    expect(problem).toMatch(/coverage\[1\]/);
    expect(problem).toMatch(/128/);
  });

  it("相邻但没合并 → 也不放行（二分查找依赖的是合并后的形状）", () => {
    expect(fontEntryProblem(entry({ coverage: [[0x20, 0x7e], [0x7f, 0x100]] })))
      .toMatch(/coverage\[1\]/);
  });

  it("单个区间起点大于终点 → 反向区间", () => {
    expect(fontEntryProblem(entry({ coverage: [[0x100, 0x20]] }))).toMatch(/reversed/);
  });

  it("码位越界、非整数、不是二元组都拦下来", () => {
    expect(fontEntryProblem(entry({ coverage: [[0, 0x110000]] }))).toMatch(/coverage\[0\]/);
    expect(fontEntryProblem(entry({ coverage: [[-1, 10]] }))).toMatch(/coverage\[0\]/);
    expect(fontEntryProblem(entry({ coverage: [[1.5, 10]] }))).toMatch(/coverage\[0\]/);
    expect(fontEntryProblem(entry({ coverage: [[1, 2, 3]] as never }))).toMatch(/pair/);
  });

  it("空 coverage 不放行 —— 它永远不会被 selectFonts 选中，只会成为死条目", () => {
    expect(fontEntryProblem(entry({ coverage: [] }))).toMatch(/empty/);
  });

  it("hash 必须是 64 位小写十六进制 —— createSBlob 只收这一种", () => {
    expect(fontEntryProblem(entry({ hash: "deadbeef" }))).toMatch(/hash/);
    expect(fontEntryProblem(entry({ hash: HASH_A.toUpperCase() }))).toMatch(/hash/);
  });

  it("名字字段缺失或空串都不放行", () => {
    expect(fontEntryProblem(entry({ postScriptName: "" }))).toMatch(/postScriptName/);
    expect(fontEntryProblem(entry({ family: undefined as never }))).toMatch(/family/);
  });

  it("载荷根本不是对象", () => {
    expect(fontEntryProblem(null)).toMatch(/JSON object/);
    expect(fontEntryProblem([entry()])).toMatch(/JSON object/);
  });
});

describe("matchFontsRoute", () => {
  it("认租户级字体路径，tenantId 解码", () => {
    expect(matchFontsRoute("/tenants/alice/fonts")).toEqual({ tenantId: "alice" });
    expect(matchFontsRoute("/tenants/a%7Cb/fonts")).toEqual({ tenantId: "a|b" });
  });

  it("会话级路径一概不认 —— 认错会让所有既有端点改道", () => {
    expect(matchFontsRoute("/tenants/alice/sessions/s1")).toBeNull();
    expect(matchFontsRoute("/tenants/alice/sessions/s1/export")).toBeNull();
    expect(matchFontsRoute("/tenants/alice/sessions/s1/fonts")).toBeNull();
  });

  it("其余形状一概不认", () => {
    expect(matchFontsRoute("/fonts")).toBeNull();
    expect(matchFontsRoute("/tenants/alice")).toBeNull();
    expect(matchFontsRoute("/tenants//fonts")).toBeNull();
    expect(matchFontsRoute("/tenants/a%ZZ/fonts")).toBeNull();
  });
});

describe("fontsObjectName", () => {
  it("两段各自编码后用 | 连 —— 带分隔符的 tenantId 不会撞名", () => {
    expect(fontsObjectName({ stackId: "cas_1", tenantId: "alice" })).toBe("cas_1|alice");
    expect(fontsObjectName({ stackId: "cas_1", tenantId: "a|b" })).not.toBe(fontsObjectName({ stackId: "cas_1|a", tenantId: "b" }));
  });

  it("空段直接抛", () => {
    expect(() => fontsObjectName({ stackId: "", tenantId: "alice" })).toThrow(/must not be empty/);
    expect(() => fontsObjectName({ stackId: "cas_1", tenantId: "" })).toThrow(/must not be empty/);
  });
});

function capability(
  sub: string,
  permissions: readonly CapabilityPermission[],
  tenantId = "tenant-1",
): VerifiedCapability {
  return {
    protectedHeader: { alg: CapabilityAlgorithm, kid: "key-1", typ: CapabilityTokenType },
    claims: {
      ver: 1,
      iss: "issuer",
      sub,
      aud: "audience",
      iat: 1000,
      nbf: 995,
      exp: 1120,
      jti: "jti-1",
      tenantId,
      sessionId: "session-1",
      permissions,
    },
  } as VerifiedCapability;
}

function edge(
  verified: VerifiedCapability,
  onFetch: (request: Request) => Promise<Response> = async () => Response.json({ ok: true }),
) {
  const seen: Request[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: (request: Request) => {
        seen.push(request);
        return onFetch(request);
      },
      id,
    }),
  } as unknown as DurableObjectNamespace;
  const audits: unknown[] = [];
  const cfg = {
    docCapabilityVerifier: { verify: vi.fn(async () => verified) },
    namespace,
    objectName: fontsObjectName({ stackId: "cas_1", tenantId: "tenant-1" }),
    audit: (event: unknown) => audits.push(event),
  };
  return { cfg, seen, audits };
}

const fontsRequest = (method: string, headers: Record<string, string> = {}): Request =>
  new Request("http://psd.local/tenants/tenant-1/fonts", {
    method,
    headers: { Authorization: "Bearer doc-token", ...headers },
    ...(method === "POST"
      ? { body: JSON.stringify(entry()), duplex: "half" }
      : {}),
  } as RequestInit);

describe("handleFontsRequest", () => {
  it("凭据合法时改写成 /_internal/fonts 转给租户级 stub", async () => {
    const { cfg, seen, audits } = edge(capability("gateway", [sessionCreatePermission("tenant-1")]));
    const response = await handleFontsRequest(cfg, fontsRequest("GET"), { tenantId: "tenant-1" });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe(FONTS_INTERNAL_PATH);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers.get("X-Tenant-Id")).toBe("tenant-1");
    expect(audits).toEqual([expect.objectContaining({ operation: "listFonts", tenantId: "tenant-1" })]);
  });

  it("POST 的 body 原样转发", async () => {
    let received: string | undefined;
    const { cfg } = edge(capability("gateway", [sessionCreatePermission("tenant-1")]), async req => {
      received = await req.text();
      return Response.json({ success: true });
    });
    await handleFontsRequest(cfg, fontsRequest("POST"), { tenantId: "tenant-1" });
    expect(JSON.parse(received!)).toEqual(entry());
  });

  it("没有 Authorization → 401，不打 DO", async () => {
    const { cfg, seen } = edge(capability("gateway", [sessionCreatePermission("tenant-1")]));
    const response = await handleFontsRequest(
      cfg,
      new Request("http://psd.local/tenants/tenant-1/fonts"),
      { tenantId: "tenant-1" },
    );
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("凭据的租户与路径不符 → 403", async () => {
    const { cfg, seen } = edge(
      capability("gateway", [sessionCreatePermission("tenant-2")], "tenant-2"),
    );
    const response = await handleFontsRequest(cfg, fontsRequest("GET"), { tenantId: "tenant-1" });
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("subject 不是 gateway → 401", async () => {
    const { cfg } = edge(capability("doc:psd", [sessionCreatePermission("tenant-1")]));
    expect((await handleFontsRequest(cfg, fontsRequest("GET"), { tenantId: "tenant-1" })).status)
      .toBe(401);
  });

  it("会话作用域的权限不顶用 —— 要的是租户作用域那一种", async () => {
    const { cfg } = edge(
      capability("gateway", [sessionWritePermission("tenant-1", "session-1")]),
    );
    expect((await handleFontsRequest(cfg, fontsRequest("GET"), { tenantId: "tenant-1" })).status)
      .toBe(403);
  });

  it("多带一份权限也不放行（照 doc 边缘的 exact 判据）", async () => {
    const { cfg } = edge(capability("gateway", [
      sessionCreatePermission("tenant-1"),
      casReadPermission("tenant-1"),
    ]));
    expect((await handleFontsRequest(cfg, fontsRequest("GET"), { tenantId: "tenant-1" })).status)
      .toBe(403);
  });

  it("R29：带了委派 CAS 凭据一律拒 —— 字体 DO 不碰 CAS", async () => {
    const { cfg, seen } = edge(capability("gateway", [sessionCreatePermission("tenant-1")]));
    const response = await handleFontsRequest(
      cfg,
      fontsRequest("GET", { "X-UniDocs-CAS-Capability": "cas-token" }),
      { tenantId: "tenant-1" },
    );
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("转发时不把任何 CAS 凭据头带下去", async () => {
    const { cfg, seen } = edge(capability("gateway", [sessionCreatePermission("tenant-1")]));
    await handleFontsRequest(cfg, fontsRequest("GET"), { tenantId: "tenant-1" });
    expect(seen[0].headers.get("X-UniDocs-CAS-Capability")).toBeNull();
    expect(seen[0].headers.get("Authorization")).toBeNull();
  });

  it("方法不支持 → 405，鉴权都不用做", async () => {
    const { cfg } = edge(capability("gateway", [sessionCreatePermission("tenant-1")]));
    const response = await handleFontsRequest(
      cfg,
      new Request("http://psd.local/tenants/tenant-1/fonts", { method: "DELETE" }),
      { tenantId: "tenant-1" },
    );
    expect(response.status).toBe(405);
    expect(cfg.docCapabilityVerifier.verify).not.toHaveBeenCalled();
  });
});
