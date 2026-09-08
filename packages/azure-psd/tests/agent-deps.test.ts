/**
 * 接线本身要能测。
 *
 * CF 侧把这段从 worker 里拆出来的理由记在 `cloudflare-psd/src/worker.ts` 的
 * `psdAgentDeps` 注释里：内联时那个工厂只在一次带凭据的真实 `/run` 里才被
 * 调到，也就是说把 `PSD_FONT_FALLBACKS` 换成 `[]`（回退链当场死掉）整套单测
 * 照样全绿。Azure 侧原来内联在 `main.ts` 里，连 tests 目录都没有 —— 同一课
 * 在这边没学到，而这正是 setText 缺席三周没被发现的一半原因。
 */
import { describe, expect, it, vi } from "vitest";
import { createPsdAgent } from "@unidocs/doctype-psd";
import type { SessionIdentity } from "@unidocs/doctype-server-common";
import type { Queryable } from "@unidocs/azure-sdk";
import { psdAgentDeps } from "../src/agent-deps.js";

const identity: SessionIdentity = { docType: "psd", sessionId: "s1", tenantId: "t1" };
// 接线只把它交给 PgFontProvider 的构造函数存起来，构造期不发一条 SQL；
// 第一次 `registry.index()` 才会走到 `list()`。
const pool = { query: async () => ({ rows: [] }) } as unknown as Queryable;

describe("psdAgentDeps", () => {
  it("没有 IMAGE_EDIT_API_KEY 就不注入 editor", () => {
    expect(psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool).editor).toBeUndefined();
  });

  it("有 key 就注入 editor", () => {
    expect(psdAgentDeps({ CAS_STACK_ID: "s", IMAGE_EDIT_API_KEY: "k" }, identity, pool).editor)
      .toBeDefined();
  });

  it("fontIndex 无条件注入：内置字体总在，setText 不会从工具表里消失", () => {
    // 判据不再是"后端在不在"。内置字体随包走之后，"有没有字体可用"永远为真，
    // 条件化只会凭空造出一条 setText 静默消失的路。
    const deps = psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool);
    expect(deps.fontIndex).toBeDefined();
  });

  it("回退链未配时取内置默认值", () => {
    // 以前这里断言的是空链，理由是"硬编码一个 CAS 里可能不存在的名字，回退链
    // 只会静默失效"。内置之后名字与字节同源、不可能不存在，那个理由消失了。
    const deps = psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool);
    expect(deps.fontIndex!.fallbacks).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
  });

  it("回退链从 PSD_FONT_FALLBACKS 解析，顺序即优先级", () => {
    const deps = psdAgentDeps(
      { CAS_STACK_ID: "s", PSD_FONT_FALLBACKS: "NotoSans, NotoSansSC" },
      identity,
      pool,
    );
    expect(deps.fontIndex!.fallbacks).toEqual(["NotoSans", "NotoSansSC"]);
  });

  it("显式空串是空链 —— 逃生口，与'未配'必须可区分", () => {
    const deps = psdAgentDeps({ CAS_STACK_ID: "s", PSD_FONT_FALLBACKS: "" }, identity, pool);
    expect(deps.fontIndex!.fallbacks).toEqual([]);
  });

  it("内置字体在索引里，且租户同名条目盖得掉它", async () => {
    const deps = psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool);
    const index = await deps.fontIndex!.registry.index();
    expect(index.get("NotoSans-Regular")!.source).toBe("builtin");
    expect(index.get("NotoSansSC-Regular")!.source).toBe("builtin");

    // 同名租户条目排在后面，按"顺序即优先级"盖掉内置那条。这就是"用户主动装
    // external 字体"的扩展点 —— 装上去就生效，不需要任何开关。
    const tenantRow = {
      post_script_name: "NotoSans-Regular",
      family: "Noto Sans",
      hash: "a".repeat(64),
      units_per_em: 1000,
      coverage: [[0x20, 0x7e]],
    };
    const withTenantFont = { query: async () => ({ rows: [tenantRow] }) } as unknown as Queryable;
    const overridden = await psdAgentDeps({ CAS_STACK_ID: "s" }, identity, withTenantFont)
      .fontIndex!.registry.index();
    expect(overridden.get("NotoSans-Regular")!.source).toBe("tenant");
    // 内置那条没被租户覆盖的仍在。
    expect(overridden.get("NotoSansSC-Regular")!.source).toBe("builtin");
  });

  it("租户 provider 打不通时只掉租户那一层，内置仍在 —— 而且喊出来", async () => {
    // 这是配 `onProviderError` 的全部意义。没配它 `createFontRegistry` 是
    // fail-hard：Postgres 抖一下整个 index() 拒绝，setText 连内置字体都排不出来。
    // 而降级必须留下信号，否则表现是"我装的字体凭空消失、字换了个字形"。
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken = {
        query: async () => { throw new Error("connection terminated"); },
      } as unknown as Queryable;
      const index = await psdAgentDeps({ CAS_STACK_ID: "s" }, identity, broken)
        .fontIndex!.registry.index();
      expect([...index.keys()]).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);

      const logged = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(logged.event).toBe("font_provider_error");
      expect(logged.providerId).toBe("tenant");
      expect(logged.error).toMatch(/connection terminated/);
    } finally {
      spy.mockRestore();
    }
  });

  it("CAS_STACK_ID 缺失时响亮失败，不静默用空串", () => {
    // 空 stackId 会让租户 provider 每次返回零条 —— 内置那一档掩护之下这条
    // 错配今天更难被看见，所以更值得在接线期就炸。
    expect(() => psdAgentDeps({}, identity, pool)).toThrow(/CAS_STACK_ID/);
  });

  /**
   * 整个字体登记表计划的验收点。
   *
   * 前面几条断言的是依赖对象的形状；这一条断言的是它真的走完了
   * `createPsdAgent` 的条件注册（agent.ts 里 fontIndex 在场才 push
   * `createSetTextTool`）。Azure 侧 setText 缺席三周，缺的正是这一环。
   */
  it("端到端：Azure 的 psd 工具表里有 setText", () => {
    const agent = createPsdAgent(psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool));
    expect(agent.tools.map(tool => tool.name)).toContain("setText");
  });

  it("端到端：没有 IMAGE_EDIT_API_KEY 时工具表里没有 editPixels，但仍有 setText", () => {
    const names = createPsdAgent(psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool))
      .tools.map(tool => tool.name);
    expect(names).not.toContain("editPixels");
    expect(names).toContain("setText");
  });
});
