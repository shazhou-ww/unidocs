/**
 * 内置字体在 Node 上的字节加载器。
 *
 * **两条路径都可能解析不到本包，所以顺序是「环境变量优先，require.resolve 兜底」，
 * 而且是惰性的。** 理由是 pnpm **不把 workspace 链接提升到仓库根**：
 * `node_modules/@unidocs/` 在根上根本不存在，软链只躺在
 * `packages/azure-psd/node_modules/@unidocs/` 里。于是从 `packages/azure-psd/`
 * 子树里调（vitest、`node dist/main.js`）解析得通，而本地 Azure 栈把这个模块
 * esbuild 打包进 `<ROOT>/.azure-runtime/bundles/psd.mjs` 之后才跑 —— 那个位置
 * 不在本包的目录子树里，`require.resolve` 当场 MODULE_NOT_FOUND。
 * （`new URL("../fonts/…", import.meta.url)` 也一样死在这里，只是错法不同：
 * 它会算出 `.azure-runtime/fonts/…` 这个不存在的路径。esbuild 的 alias 帮不上忙，
 * 它不改写 `require.resolve` 的字符串实参。）
 *
 * 所以 `stacks/unidocs-azure/local/runtime.mjs` 的 `spawnService` 直接把
 * `UNIDOCS_BUILTIN_FONTS_DIR` 传进来（它手里有 ROOT）。生产镜像里
 * `pnpm deploy --prod` 产出真实（非软链）的 node_modules 且入口就在包内，
 * 走 `require.resolve` 那条默认分支。
 *
 * **惰性求值**同样是必需的，不只是风格问题：写成模块顶层 const 的话，解析失败
 * 会在 **import 期**抛 —— 表现是整个 psd 服务起不来，而不是「某套字体读不到」。
 * 惰性之后最坏情况是一条点名 `@unidocs/fonts-builtin` 的加载错误。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BuiltinFontLoader } from "@unidocs/fonts-builtin";

let fontsDir: string | undefined;

function resolveFontsDir(): string {
  if (fontsDir !== undefined) return fontsDir;
  const fromEnv = process.env.UNIDOCS_BUILTIN_FONTS_DIR;
  if (fromEnv) return (fontsDir = fromEnv);
  try {
    // `@unidocs/fonts-builtin` 的 package.json 必须导出 `"./package.json"` —— 没有
    // 那一条，`require.resolve` 在 Node 的 exports 封装下会被拒。
    const require = createRequire(import.meta.url);
    return (fontsDir = join(dirname(require.resolve("@unidocs/fonts-builtin/package.json")), "fonts"));
  } catch (cause) {
    throw new Error(
      "Cannot locate @unidocs/fonts-builtin: it is not resolvable from this module's location"
      + " and UNIDOCS_BUILTIN_FONTS_DIR is not set."
      + " A bundle written outside packages/azure-psd/ (e.g. .azure-runtime/bundles/psd.mjs)"
      + " must be given UNIDOCS_BUILTIN_FONTS_DIR.",
      { cause },
    );
  }
}

export const builtinFontLoader: BuiltinFontLoader = async fileName =>
  new Uint8Array(await readFile(join(resolveFontsDir(), fileName)));
