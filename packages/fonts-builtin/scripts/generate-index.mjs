/**
 * 从 fonts/ 下的字节生成 src/fonts.generated.ts。
 *
 * **coverage / unitsPerEm / family / hash 全部从字节解析，一个都不许手写。**
 * 解析用的是 `scripts/psd-fonts-kit.ts` 的 `fontCoverage`/`parseFontFace` ——
 * 与 `seed-psd-fonts.mjs` 登记字体时用的**同一份实现**。第二份实现意味着两边
 * 对"覆盖了哪些码位"的判断可能分叉，而分叉的表现是某个字被判成"这套字体不认识"
 * 然后静默掉进回退链。
 *
 * 从 `seed-psd-fonts.mjs` 而不是从 `psd-fonts-kit.ts` 拿 `loadKit`：那个 `.ts`
 * 文件本身不导出 `loadKit`，它是被 `loadKit` 用 esbuild 打包后才 import 的
 * （它引用工作区源码，要靠 esbuild 的 alias 才解析得了）。既有调用方
 * `scripts/psd-font-bootstrap.mjs` 与既有测试也都是从这里 import 的。
 *
 * 索引在构建期生成并提交、运行期零解析：一个 1.9 MB 的 CFF 字体每次进程启动解析
 * 一遍是白花的钱。
 *
 * 用法：node scripts/generate-index.mjs
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../../scripts/seed-psd-fonts.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

/** 要装哪几套。顺序即回退链顺序：拉丁在前、中文在后 —— 前者不覆盖 CJK，
 *  汉字自然落到后者。 */
const PLAN = [
  { file: "NotoSans-Regular.ttf", postScriptName: "NotoSans-Regular", family: "Noto Sans" },
  { file: "NotoSansSC-Regular.subset.otf", postScriptName: "NotoSansSC-Regular", family: "Noto Sans SC" },
];

const kit = await loadKit();
const records = [];
for (const font of PLAN) {
  const bytes = new Uint8Array(await readFile(join(PKG, "fonts", font.file)));
  const face = kit.parseFontFace(bytes);
  if (face.postScriptName !== font.postScriptName) {
    throw new Error(`${font.file} 解析出的 postScriptName 是 "${face.postScriptName}"，计划里写的是 "${font.postScriptName}"`);
  }
  const coverage = kit.fontCoverage(face);
  if (coverage.length === 0) throw new Error(`${font.file} 一个码位都不覆盖`);
  records.push({
    file: font.file,
    entry: {
      postScriptName: font.postScriptName,
      family: font.family,
      hash: createHash("sha256").update(bytes).digest("hex"),
      unitsPerEm: face.unitsPerEm,
      coverage,
    },
  });
}

const body = `/**
 * 由 scripts/generate-index.mjs 从 fonts/ 下的字节生成。**不要手改。**
 *
 * 改了字体文件就重跑：
 *   python3 scripts/build-subset.py <全量 NotoSansSC-Regular.otf>
 *   node scripts/generate-index.mjs
 * tests/generated-index.test.ts 会从字节重新解析并逐字段比对，手改会当场变红。
 */
import type { BuiltinFontRecord } from "./types.js";

export const BUILTIN_FONTS: readonly BuiltinFontRecord[] = Object.freeze(${
  JSON.stringify(records, null, 2)
} as const);
`;
await writeFile(join(PKG, "src", "fonts.generated.ts"), body);
console.log(`已写 src/fonts.generated.ts：${records.map(r => `${r.entry.postScriptName}(${r.entry.coverage.length} 段)`).join(", ")}`);
