import { describe, expect, it } from "vitest";
import type { FontIo } from "@unidocs/doctype-server-common";
import { BUILTIN_FALLBACKS, BUILTIN_FONTS, createBuiltinFontProvider } from "../src/index.js";

const neverCalled: FontIo = {
  readBlob: () => { throw new Error("内置来源不该碰 io.readBlob"); },
};

describe("createBuiltinFontProvider", () => {
  it("id 是 builtin", () => {
    expect(createBuiltinFontProvider({ load: async () => new Uint8Array() }).id).toBe("builtin");
  });

  it("list 原样交出生成的索引条目", async () => {
    const provider = createBuiltinFontProvider({ load: async () => new Uint8Array() });
    expect(await provider.list()).toEqual(BUILTIN_FONTS.map(r => r.entry));
  });

  it("read 按 postScriptName 找到对应文件名，且不碰 io", async () => {
    const asked: string[] = [];
    const provider = createBuiltinFontProvider({
      load: async fileName => { asked.push(fileName); return new Uint8Array([1, 2, 3]); },
    });
    const [latin] = await provider.list();
    expect(await provider.read(latin!, neverCalled)).toEqual(new Uint8Array([1, 2, 3]));
    expect(asked).toEqual(["NotoSans-Regular.ttf"]);
  });

  it("read 收到不属于本来源的条目时响亮失败", async () => {
    const provider = createBuiltinFontProvider({ load: async () => new Uint8Array() });
    const alien = { ...BUILTIN_FONTS[0]!.entry, postScriptName: "Helvetica" };
    await expect(provider.read(alien, neverCalled)).rejects.toThrow(/not a builtin font/i);
  });

  it("blobFor 恒为 null —— 内置字节不在 CAS 里，没有可回收的对象", async () => {
    const provider = createBuiltinFontProvider({ load: async () => new Uint8Array() });
    for (const entry of await provider.list()) expect(provider.blobFor(entry)).toBeNull();
  });

  it("BUILTIN_FALLBACKS 与索引顺序一致：拉丁在前、中文在后", () => {
    expect(BUILTIN_FALLBACKS).toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
  });
});
