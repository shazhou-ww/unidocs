/**
 * 守住「生成物与字节不漂移」。
 *
 * 这条测试防的不是 generate-index.mjs 写错了 —— 它防的是**有人手改了
 * fonts.generated.ts**，或者**换了字体文件但忘了重跑生成脚本**。两种情况的
 * 线上表现都是某些字被判成"这套字体不认识"然后静默掉进回退链，不报错。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fontEntryProblem } from "@unidocs/doctype-server-common";
import { BUILTIN_FONTS } from "../src/index.js";
import { loadKit } from "../../../scripts/seed-psd-fonts.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

// loadKit() 每次调用都跑一遍 esbuild。提到循环外只跑一次 —— 每套字体各跑一次
// 除了让这套测试变慢，不会多验证任何东西。
const kit = await loadKit();

describe("BUILTIN_FONTS", () => {
  it("两套字体：拉丁在前、中文在后（顺序即回退链顺序）", () => {
    expect(BUILTIN_FONTS.map(r => r.entry.postScriptName))
      .toEqual(["NotoSans-Regular", "NotoSansSC-Regular"]);
  });

  /**
   * 内置条目**绕过写入侧的校验**，所以形状要在这里挡。
   *
   * `fontEntryProblem` 的注释自己写着：coverage 的升序/不重叠/已合并是硬要求，
   * `coversCodePoint` 的二分查找对乱序或重叠会**静默返回错的结果**（那个字被判
   * 成"这套字体不认识"，掉进回退链，不报错），而"写入侧是唯一挡得住的地方"。
   * 内置是本仓库的第二个字体来源，它**永远不经过写入侧** —— 它的条目直接从
   * `fonts.generated.ts` 进合成。上面那条"索引与字节对得上"只保证生成物没漂移，
   * 保证不了生成规则本身产出的形状合法；下次换字体版本、换解析器时挡在这里的
   * 就是这一句。
   */
  for (const record of BUILTIN_FONTS) {
    it(`${record.entry.postScriptName}：条目形状过写入侧那套校验`, () => {
      expect(fontEntryProblem(record.entry)).toBeNull();
    });
  }

  for (const record of BUILTIN_FONTS) {
    it(`${record.entry.postScriptName}：索引与字节逐字段对得上`, async () => {
      const bytes = new Uint8Array(await readFile(join(PKG, "fonts", record.file)));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.entry.hash);
      const face = kit.parseFontFace(bytes);
      expect(face.postScriptName).toBe(record.entry.postScriptName);
      expect(face.unitsPerEm).toBe(record.entry.unitsPerEm);
      expect(kit.fontCoverage(face)).toEqual(record.entry.coverage);
    });
  }

  it("中文那套覆盖字表里全部 8105 个字，一个不漏", async () => {
    const chars = (await readFile(join(PKG, "charset", "tongyong-guifan-8105.txt"), "utf8")).split(/\s+/).filter(Boolean);
    expect(chars).toHaveLength(8105);
    const sc = BUILTIN_FONTS.find(r => r.entry.postScriptName === "NotoSansSC-Regular")!;
    const covers = (cp: number) => sc.entry.coverage.some(([a, b]) => cp >= a && cp <= b);
    const missing = chars.filter(c => !covers(c.codePointAt(0)!));
    expect(missing).toEqual([]);
  });

  it("拉丁那套覆盖全部 ASCII 可打印字符", () => {
    const latin = BUILTIN_FONTS.find(r => r.entry.postScriptName === "NotoSans-Regular")!;
    const covers = (cp: number) => latin.entry.coverage.some(([a, b]) => cp >= a && cp <= b);
    for (let cp = 0x20; cp <= 0x7e; cp++) expect(covers(cp), `U+${cp.toString(16)}`).toBe(true);
  });

  it("每套字体的体积都在 R19 改写后的 3 MiB 上限内", async () => {
    for (const record of BUILTIN_FONTS) {
      const bytes = await readFile(join(PKG, "fonts", record.file));
      expect(bytes.byteLength, record.file).toBeLessThan(3 * 1024 * 1024);
    }
  });
});
