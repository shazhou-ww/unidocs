import { describe, expect, it } from "vitest";
import { matchFontsRoute } from "../src/routes.js";

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
