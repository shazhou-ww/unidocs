/**
 * 内置字体在 Cloudflare 上的字节加载器。
 *
 * Workers 没有文件系统，字节必须在**打包时**内联进 worker 产物 —— 这就是这里
 * 用静态 import 而不是任何形式的运行时读取的原因。三处打包配置缺一不可：
 * 生产的 `wrangler.toml` 的 `[[rules]] type = "Data"`、本地栈
 * `stacks/unidocs-cloudflare/local/runtime.mjs` 的 esbuild `loader`，以及
 * `stacks/unidocs-azure/local/runtime.mjs` 的同一项（冗余保险，见那里的注释）。
 * 漏配的表现是**构建期报错**（bundler 不认识 .ttf 扩展名），不是运行时静默
 * 失效 —— 这是刻意选的：静默失效等于「中文层整层画不出来」且毫无线索。
 *
 * 体积核对：psd 的 worker bundle 原本 1.69 MB / gzip 358 KB，两套字体 gzip 后
 * 合计 1.84 MB，加起来约 2.2 MB，离 Cloudflare 10 MB（压缩后）上限有大量余量。
 */
import type { BuiltinFontLoader } from "@unidocs/fonts-builtin";
import notoSans from "@unidocs/fonts-builtin/fonts/NotoSans-Regular.ttf";
import notoSansSC from "@unidocs/fonts-builtin/fonts/NotoSansSC-Regular.subset.otf";

const BYTES: Readonly<Record<string, Uint8Array>> = Object.freeze({
  "NotoSans-Regular.ttf": notoSans,
  "NotoSansSC-Regular.subset.otf": notoSansSC,
});

export const builtinFontLoader: BuiltinFontLoader = async fileName => {
  const bytes = BYTES[fileName];
  // 打包配置漏了某个文件时，这里比「字体解析失败」好查得多。
  if (!bytes) throw new Error(`Builtin font ${fileName} was not bundled into the worker`);
  return bytes;
};
