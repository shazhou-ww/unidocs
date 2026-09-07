/**
 * `psdAgentDeps` 的接线。
 *
 * 这段原先内联在 `createOperatorDO` 的 agent 工厂里，而那个工厂只在一次带
 * 凭据的真实 `/run` 里才被调到 —— 评审用注入法证实：把
 * `parseFontFallbacks(env.PSD_FONT_FALLBACKS)` 换成 `[]`（回退链当场死掉），
 * 整套单测照样全绿。这里断言的就是那几条"只连一次、连错了没人知道"的线。
 */
import { describe, expect, it } from "vitest";
import { psdAgentDeps } from "../src/agent-deps.js";

const namespace = {
  idFromName: (name: string) => name,
  get: () => ({ fetch: async () => Response.json({ fonts: [] }) }),
};

const baseEnv = { CAS_STACK_ID: "cas_1" };
const env = (extra: Record<string, unknown> = {}) =>
  ({ ...baseEnv, ...extra }) as unknown as Parameters<typeof psdAgentDeps>[0];
const identity = { tenantId: "alice", sessionId: "s1" };

describe("psdAgentDeps 的接线", () => {
  it("PSD_FONT_FALLBACKS 真的接到了 fontIndex 上 —— 顺序即优先级", () => {
    const deps = psdAgentDeps(
      env({ PSD_FONTS: namespace, PSD_FONT_FALLBACKS: "NotoSans,NotoSansSC" }),
      identity,
    );
    expect(deps.fontIndex?.fallbacks).toEqual(["NotoSans", "NotoSansSC"]);
  });

  it("没配 PSD_FONT_FALLBACKS 时是空链，不硬编码字体名", () => {
    // 硬编码一个 CAS 里可能不存在的名字，只会让回退链静默失效。
    const deps = psdAgentDeps(env({ PSD_FONTS: namespace }), identity);
    expect(deps.fontIndex?.fallbacks).toEqual([]);
  });

  it("没有 PSD_FONTS 绑定就没有 fontIndex —— 工具表里也就没有 setText", () => {
    // 绑定缺失只可能是漏配。宁可工具表里没有 setText，也好过注册一个每次
    // 调用都在 namespace.get 上炸的工具。
    expect(psdAgentDeps(env(), identity).fontIndex).toBeUndefined();
  });

  it("没有 IMAGE_EDIT_API_KEY 就没有 editor —— 与 fontIndex 各自独立", () => {
    const deps = psdAgentDeps(env({ PSD_FONTS: namespace }), identity);
    expect(deps.editor).toBeUndefined();
    expect(deps.fontIndex).toBeDefined();
  });
});
