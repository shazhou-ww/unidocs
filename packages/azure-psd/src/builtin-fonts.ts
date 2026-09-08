/**
 * 内置字体在 Node 上的字节加载器。
 *
 * **不用 `new URL("../fonts/…", import.meta.url)`。** 那样解析出来的是「相对本
 * 模块文件」的路径，而本模块在本地 Azure 栈里是被 esbuild 打包进
 * `.azure-runtime/bundles/psd.mjs` 之后才跑的 —— 相对路径会指到 `.azure-runtime/`
 * 底下去，文件不存在。`createRequire` 走的是 node_modules 解析，打包前后都对：
 * 打包产物落在仓库内，向上找得到 workspace 的软链；镜像里 `pnpm deploy --prod`
 * 产出的是真实（非软链）的 node_modules，同样找得到。
 *
 * 这也是 `@unidocs/fonts-builtin` 的 package.json 必须导出 `"./package.json"`
 * 的原因 —— 没有那一条，`require.resolve` 在 Node 的 exports 封装下会被拒。
 *
 * 失败要响亮：`readFile` 的 ENOENT 里带着完整路径，比静默返回空字节好查得多
 * （空字节的表现是「这套字体解析失败」，看不出是哪个文件没找到）。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BuiltinFontLoader } from "@unidocs/fonts-builtin";

const require = createRequire(import.meta.url);
const FONTS_DIR = join(dirname(require.resolve("@unidocs/fonts-builtin/package.json")), "fonts");

export const builtinFontLoader: BuiltinFontLoader = async fileName =>
  new Uint8Array(await readFile(join(FONTS_DIR, fileName)));
