/**
 * 加载器是「字节怎么从包里拿出来」这一步的全部实现，而它一旦悄悄错了，表现
 * 是「这套字体解析失败」而不是「文件找不到」——所以这里既比哈希（拿到的确实
 * 是索引里登记的那份字节），也验失败路径必须抛。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_FONTS } from "@unidocs/fonts-builtin";
import { builtinFontLoader } from "../src/builtin-fonts.js";

describe("builtinFontLoader (Node)", () => {
  it("每一套内置字体都读得出来，且哈希对得上", async () => {
    const { createHash } = await import("node:crypto");
    for (const record of BUILTIN_FONTS) {
      const bytes = await builtinFontLoader(record.file);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.entry.hash);
    }
  });

  it("文件不存在时响亮失败，不返回空字节", async () => {
    await expect(builtinFontLoader("NoSuchFont.ttf")).rejects.toThrow();
  });
});

/**
 * `UNIDOCS_BUILTIN_FONTS_DIR` 分支。它是本地 Azure 栈**唯一**能用的那条：
 * pnpm 不把 workspace 链接提升到仓库根，所以从
 * `<ROOT>/.azure-runtime/bundles/psd.mjs` 调 `require.resolve` 是
 * MODULE_NOT_FOUND。这里就地跑时 resolve 那条恰好通，所以必须显式
 * `resetModules` 才测得到环境变量分支（目录只解析一次并缓存）。
 */
describe("UNIDOCS_BUILTIN_FONTS_DIR", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("设了就优先读它", async () => {
    vi.resetModules();
    vi.stubEnv("UNIDOCS_BUILTIN_FONTS_DIR", new URL("../../fonts-builtin/fonts", import.meta.url).pathname);
    const mod = await import("../src/builtin-fonts.js");
    const { createHash } = await import("node:crypto");
    const record = BUILTIN_FONTS[0]!;
    const bytes = await mod.builtinFontLoader(record.file);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.entry.hash);
  });

  it("指向不存在的目录时报的是那个目录，不是静默空字节", async () => {
    vi.resetModules();
    vi.stubEnv("UNIDOCS_BUILTIN_FONTS_DIR", "/definitely/not/a/fonts/dir");
    const mod = await import("../src/builtin-fonts.js");
    await expect(mod.builtinFontLoader(BUILTIN_FONTS[0]!.file))
      .rejects.toThrow(/\/definitely\/not\/a\/fonts\/dir/);
  });
});
