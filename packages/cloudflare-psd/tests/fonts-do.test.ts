/**
 * 字体索引 DO 本体。
 *
 * `/tenants/{t}/fonts` 的路由匹配与边缘鉴权/转发已经下沉到中立层，测试跟着
 * 搬到了 `packages/protocol-doc/tests/routes-fonts.test.ts`（路由匹配）与
 * `packages/doctype-server-common/tests/font-registry-handler.test.ts`
 * （边缘鉴权/转发，14 条）。这里只剩 DO 本体与 `fontsObjectName` 这两样
 * 没搬走的东西 —— 适配层的契约测试在同目录的 `font-registry-do.test.ts`。
 *
 * 这个包此前没有任何测试基建，也没有 `@cloudflare/vitest-pool-workers`。
 * DO 的 sqlite 用 `node:sqlite` 顶上：`ctx.storage.sql.exec` 的形状（可变位置
 * 绑定参数 + `.toArray()`）转发给一个内存 sqlite，语义是真的 SQL —— 主键、
 * `INSERT OR REPLACE`、`ORDER BY` 都不用假装。只在测试里用，运行时代码不碰
 * 任何 Node 内置模块。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { FontEntry } from "@unidocs/doctype-psd";
import { FONTS_INTERNAL_PATH, fontsObjectName, PsdFontsDurableObject } from "../src/fonts-do.js";

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
