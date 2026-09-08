/**
 * 守住"字节真的进了发行产物"。
 *
 * Dockerfile（`stacks/unidocs-azure/deploy/Dockerfile`）用
 * `pnpm deploy --legacy --prod` 把 azure-psd 连同它的依赖裁剪进 `/out`。
 * 工作区包在那一步是按 `package.json` 的 `files` 打包的（外加 npm 一贯无条件
 * 带上的 package.json / README / `main` 指向的那个入口文件）。漏了 `fonts` 的
 * 症状与"这个环境从没灌过字体"一模一样：setText 还在工具表里，每次调用都取不到
 * 字形，不报错。那正是本次重构要消灭的症状，所以要有东西盯着。
 *
 * **`publishConfig` 在这一步不生效**（pnpm 11.24.0 实测：`/out` 里这个包的
 * `main` 仍然是 `./src/index.ts`，`exports["."]` 也还指向 src）。它不构成问题，
 * 因为 `packages/azure-psd` 的 `build` 是 `tsc && node scripts/bundle.mjs`，
 * 交付的 `dist/main.js` 是个自包含 bundle，运行时不解析任何 `@unidocs/*` 说明符。
 * **唯一在运行时被解析的说明符**是 `builtin-fonts.ts` 里那句
 * `require.resolve("@unidocs/fonts-builtin/package.json")` —— 而 `./package.json`
 * 这一条在 `exports` 与 `publishConfig.exports` 里逐字相同，所以它照样解析得到，
 * 再 `join(dirname(...), "fonts")` 就是随包发行的那两个文件。
 *
 * 于是这里盯的是那条链上真正承重的三件事：`files` 带上 `fonts`（字节进得去）、
 * `files` 带上 `dist`（CF 侧 wrangler 那条路要的编译产物）、以及两份 exports 都
 * 导出 `./package.json`（Node 侧加载器唯一的定位手段 —— 少了它，Node 的 exports
 * 封装会直接拒绝那次 require.resolve）。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_FONTS } from "../src/index.js";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

interface Manifest {
  files: string[];
  exports: Record<string, unknown>;
  publishConfig: { exports: Record<string, unknown> };
}

const manifest = async (): Promise<Manifest> =>
  JSON.parse(await readFile(join(PKG, "package.json"), "utf8")) as Manifest;

describe("发行产物", () => {
  it("package.json 的 files 必须同时包含 dist 与 fonts", async () => {
    const pkg = await manifest();
    expect(pkg.files).toContain("fonts");
    expect(pkg.files).toContain("dist");
  });

  it("exports 里有 ./package.json —— Node 侧加载器靠 require.resolve 找目录", async () => {
    const pkg = await manifest();
    expect(pkg.exports["./package.json"]).toBe("./package.json");
    // publishConfig 那份在 `pnpm deploy` 里其实不被套用，但 `npm publish` 会套用，
    // 而两份必须给出同一个答案 —— 加载器只认得这一条路。
    expect(pkg.publishConfig.exports["./package.json"]).toBe("./package.json");
  });

  it("索引里点名的每个文件都真的在 fonts/ 下", async () => {
    for (const record of BUILTIN_FONTS) {
      await expect(readFile(join(PKG, "fonts", record.file))).resolves.toBeDefined();
    }
  });
});
