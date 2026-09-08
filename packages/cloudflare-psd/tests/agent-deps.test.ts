/**
 * `psdAgentDeps` 的接线。
 *
 * 这段原先内联在 `createOperatorDO` 的 agent 工厂里，而那个工厂只在一次带
 * 凭据的真实 `/run` 里才被调到 —— 评审用注入法证实：把
 * `parseFontFallbacks(env.PSD_FONT_FALLBACKS)` 换成 `[]`（回退链当场死掉），
 * 整套单测照样全绿。这里断言的就是那几条"只连一次、连错了没人知道"的线。
 *
 * 这个文件也吸收了原 `tests/fonts-source.test.ts` 里还站得住的两块：
 * "注入之后 setText 进工具表、说明块也跟着进提示词"，以及租户那一档的 DO 接线。
 * 其余（DO 响应 → FontIndex、TTL 缓存）已经下沉到中立层，由
 * `font-provider-do.test.ts` 与 `doctype-server-common` 的用例守住。
 */
import { describe, expect, it, vi } from "vitest";
import { createPsdAgent } from "@unidocs/doctype-psd";
import type { FontEntry } from "@unidocs/doctype-server-common";
import { psdAgentDeps } from "../src/agent-deps.js";

const tenantFont: FontEntry = {
  postScriptName: "NotoSans-Regular",
  family: "Noto Sans",
  hash: "a".repeat(64),
  unitsPerEm: 1000,
  coverage: [[0x20, 0x7e]],
};

/** 门面是惰性的：构造期不打后端，第一次 `index()` 才 `namespace.get(...).fetch(...)`。 */
const namespaceReturning = (fonts: FontEntry[]) => ({
  idFromName: (name: string) => name,
  get: () => ({ fetch: async () => Response.json({ fonts }) }),
});

const namespaceThrowing = () => ({
  idFromName: (name: string) => name,
  get: () => ({ fetch: async () => { throw new Error("DO unreachable"); } }),
});

const baseEnv = { CAS_STACK_ID: "cas_1" };
const env = (extra: Record<string, unknown> = {}) =>
  ({ ...baseEnv, ...extra }) as unknown as Parameters<typeof psdAgentDeps>[0];
const identity = { tenantId: "alice", sessionId: "s1" };

describe("psdAgentDeps 的接线", () => {
  it("PSD_FONT_FALLBACKS 真的接到了 fontIndex 上 —— 顺序即优先级", () => {
    const deps = psdAgentDeps(
      env({ PSD_FONTS: namespaceReturning([]), PSD_FONT_FALLBACKS: "NotoSans,NotoSansSC" }),
      identity,
    );
    expect(deps.fontIndex!.fallbacks).toEqual(["NotoSans", "NotoSansSC"]);
  });

  it("回退链未配时取内置默认值", () => {
    // 以前这里断言的是空链，理由是"硬编码一个 CAS 里可能不存在的名字，回退链
    // 只会静默失效"。内置之后名字与字节同源、不可能不存在，那个理由消失了。
    const deps = psdAgentDeps(env({ PSD_FONTS: namespaceReturning([]) }), identity);
    expect(deps.fontIndex!.fallbacks).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
  });

  it("显式空串是空链 —— 逃生口，与'未配'必须可区分", () => {
    const deps = psdAgentDeps(env({ PSD_FONT_FALLBACKS: "" }), identity);
    expect(deps.fontIndex!.fallbacks).toEqual([]);
  });

  it("没有 PSD_FONTS 绑定，fontIndex 仍然在 —— setText 不会从工具表里消失", () => {
    // 这条以前断言的正好相反（"没有绑定就没有 fontIndex"）。判据是一条**可能
    // 漏配**的 DO 绑定，而漏配的表现是 setText 整个消失：平台能力差异变成一次
    // 礼貌的拒绝，没有任何一步失败，日志、测试、告警全都看不见。
    expect(psdAgentDeps(env(), identity).fontIndex).toBeDefined();
  });

  it("没有 PSD_FONTS 绑定时索引里仍有两套内置字体", async () => {
    const index = await psdAgentDeps(env(), identity).fontIndex!.registry.index();
    expect([...index.keys()]).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
    expect(index.get("NotoSans-Regular")!.source).toBe("builtin");
    expect(index.get("NotoSansSC-Regular")!.source).toBe("builtin");
  });

  it("租户同名条目盖得掉内置的 —— 顺序即优先级", async () => {
    const deps = psdAgentDeps(env({ PSD_FONTS: namespaceReturning([tenantFont]) }), identity);
    const index = await deps.fontIndex!.registry.index();
    expect(index.get("NotoSans-Regular")!.source).toBe("tenant");
    // 租户没覆盖的那条内置仍在。
    expect(index.get("NotoSansSC-Regular")!.source).toBe("builtin");
  });

  it("字体 DO 打不通时只掉租户那一层，内置仍在 —— 而且喊出来", async () => {
    // 这是配 `onProviderError` 的全部意义。没配它 `createFontRegistry` 是
    // fail-hard：DO 抖一下整个 index() 拒绝，setText 连内置字体都排不出来。
    // 而降级必须留下信号，否则表现是"我装的字体凭空消失、字换了个字形"。
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = psdAgentDeps(env({ PSD_FONTS: namespaceThrowing() }), identity);
      const index = await deps.fontIndex!.registry.index();
      expect([...index.keys()]).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);

      const logged = JSON.parse(spy.mock.calls[0]![0] as string);
      expect(logged.event).toBe("font_provider_error");
      expect(logged.providerId).toBe("tenant");
      expect(logged.error).toMatch(/DO unreachable/);
    } finally {
      spy.mockRestore();
    }
  });

  it("没有 IMAGE_EDIT_API_KEY 就没有 editor —— editPixels 的条件化不变", () => {
    const deps = psdAgentDeps(env({ PSD_FONTS: namespaceReturning([]) }), identity);
    expect(deps.editor).toBeUndefined();
    expect(deps.fontIndex).toBeDefined();
  });

  it("有 key 就注入 editor", () => {
    expect(psdAgentDeps(env({ IMAGE_EDIT_API_KEY: "k" }), identity).editor).toBeDefined();
  });
});

describe("接上 agent", () => {
  // `createPsdAgent` 把工具表和提示词一起条件化，所以两边一起断言 ——
  // 只有一边出现就是幽灵工具。
  it("最小 env（没有 PSD_FONTS）下 setText 就在工具表里，说明块也在提示词里", () => {
    const agent = createPsdAgent(psdAgentDeps(env(), identity));
    expect(agent.tools.map(tool => tool.name)).toContain("setText");
    expect(agent.instructions).toMatch(/setText/);
  });

  it("最小 env 下没有 editPixels —— 条件化只剩它一个", () => {
    const agent = createPsdAgent(psdAgentDeps(env(), identity));
    expect(agent.tools.map(tool => tool.name)).not.toContain("editPixels");
    expect(agent.instructions).not.toMatch(/editPixels/);
  });
});
