/**
 * 守住"字节真的进了发行产物"。
 *
 * Dockerfile（`stacks/unidocs-azure/deploy/Dockerfile`）用
 * `pnpm deploy --legacy --prod` 把 azure-psd 连同它的依赖裁剪进 `/out`。
 * 工作区包在那一步是按 `package.json` 的 `files` 打包的（外加 npm 一贯无条件
 * 带上的 package.json / README / `main` 指向的那个入口文件）。
 *
 * **`files` 只在打包裁剪那条路上起作用**（`npm publish` / `pnpm deploy`），也就是
 * 只影响 Azure 镜像。Cloudflare 不在这条路上：`wrangler deploy` 直接对工作区跑，
 * `fonts/` 本来就躺在那儿，`files` 写错了它也照样打得进 worker 产物。
 *
 * 漏了 `fonts` 的后果因此只落在镜像里，而且是"这个环境的 setText 从此每次都炸"：
 * `require.resolve("@unidocs/fonts-builtin/package.json")` **仍然解析得到**
 * （package.json 永远会被打包），于是 `join(dirname(...), "fonts")` 指向一个不存在
 * 的目录，`builtinFontLoader` 的 `readFile` 抛 ENOENT；而 `set-text.ts` 的
 * `loadFonts` 那一段没有任何 try/catch，异常一路穿出 effect。是响亮失败不是静默
 * 少字 —— 但那个环境从此没有 setText，与"这个环境从没灌过字体"是同一种损失。
 * 那正是本次重构要消灭的损失，所以要有东西盯着。
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
 * 三条断言各自守什么：
 *
 *  - `files` 带上 `fonts` —— 字节进得去（上面那一段）。
 *  - `files` 带上 `dist` —— 这一条服务的是 `npm publish` 那条路：`publishConfig`
 *    把 `main`、`types` 和 `exports` 的 `"."` 这一条指向 `./dist/*`（`"./fonts/*"`
 *    与 `"./package.json"` 两条不指向 dist，它们两份 exports 里逐字相同），
 *    `files` 不含 `dist` 就会发出一个主入口指向空气的包。
 *
 *    `dist` **运行时**确实没有消费者（两个平台包交付的都是自包含 bundle，wrangler
 *    解析本包走的还是 `main`/`exports` → `./src/index.ts`），但**构建期有**：本包是
 *    `composite: true` + `outDir: ./dist`，`cloudflare-psd` 与 `azure-psd` 的
 *    tsconfig 都 `references` 它，两者的 `tsconfig.tsbuildinfo` 里
 *    `fonts-builtin/dist/*.d.ts` 各命中 5 条、`fonts-builtin/src` 各 0 条 ——
 *    `tsc` 读的是 `dist` 那份声明。而 Dockerfile 正是 `pnpm -r build` 之后才
 *    `pnpm deploy`，所以镜像构建期就在消费这个 `dist`。
 *  - 两份 exports 都导出 `./package.json` —— Node 侧加载器唯一的定位手段：少了
 *    它，Node 的 exports 封装会直接拒绝那次 `require.resolve`。
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
    // fonts：镜像里的字节。dist：npm publish 那条路的入口（publishConfig 指向它）。
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
