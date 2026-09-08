/**
 * 加载器是「字节怎么从包里拿出来」这一步的全部实现，而它一旦悄悄错了，表现
 * 是「这套字体解析失败」而不是「文件找不到」——所以这里既比哈希（拿到的确实
 * 是索引里登记的那份字节），也验失败路径必须抛。
 */
import { describe, expect, it } from "vitest";
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
