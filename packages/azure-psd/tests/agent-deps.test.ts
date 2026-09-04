/**
 * 接线本身要能测。
 *
 * CF 侧把这段从 worker 里拆出来的理由记在 `cloudflare-psd/src/worker.ts` 的
 * `psdAgentDeps` 注释里：内联时那个工厂只在一次带凭据的真实 `/run` 里才被
 * 调到，也就是说把 `PSD_FONT_FALLBACKS` 换成 `[]`（回退链当场死掉）整套单测
 * 照样全绿。Azure 侧原来内联在 `main.ts` 里，连 tests 目录都没有 —— 同一课
 * 在这边没学到，而这正是 setText 缺席三周没被发现的一半原因。
 */
import { describe, expect, it } from "vitest";
import { createPsdAgent } from "@unidocs/doctype-psd";
import type { SessionIdentity } from "@unidocs/doctype-server-common";
import type { Queryable } from "@unidocs/azure-sdk";
import { psdAgentDeps } from "../src/agent-deps.js";

const identity: SessionIdentity = { docType: "psd", sessionId: "s1", tenantId: "t1" };
// 接线只把它交给 PgFontRegistry 的构造函数存起来，构造期不发一条 SQL。
const pool = {} as Queryable;

describe("psdAgentDeps", () => {
  it("没有 IMAGE_EDIT_API_KEY 就不注入 editor", () => {
    expect(psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool).editor).toBeUndefined();
  });

  it("有 key 就注入 editor", () => {
    expect(psdAgentDeps({ CAS_STACK_ID: "s", IMAGE_EDIT_API_KEY: "k" }, identity, pool).editor)
      .toBeDefined();
  });

  it("总是注入 fontIndex —— Postgres 后端不像 DO 绑定那样会漏配", () => {
    // CF 那边 fontIndex 是条件的：PSD_FONTS 是一条可能漏配的 DO 绑定。这边
    // 的后端就是本进程已经在用的那个连接池，没有"漏配"这种状态可言，所以
    // 无条件注入 —— 条件化只会凭空造出一条 setText 静默消失的路。
    expect(psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool).fontIndex).toBeDefined();
  });

  it("回退链从 PSD_FONT_FALLBACKS 解析，顺序即优先级", () => {
    const deps = psdAgentDeps(
      { CAS_STACK_ID: "s", PSD_FONT_FALLBACKS: "NotoSans, NotoSansSC" },
      identity,
      pool,
    );
    expect(deps.fontIndex?.fallbacks).toEqual(["NotoSans", "NotoSansSC"]);
  });

  it("没配 PSD_FONT_FALLBACKS 时是空链，不硬编码字体名", () => {
    // 硬编码一个 CAS 里可能不存在的名字，回退链只会静默失效 ——
    // `resolveFaceChain` 对没装载的候选是直接跳过，不报错。
    expect(psdAgentDeps({ CAS_STACK_ID: "s" }, identity, pool).fontIndex?.fallbacks).toEqual([]);
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
