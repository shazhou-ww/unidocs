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
 * 合计约 1.84 MB，加起来约 2.2 MB，离 Cloudflare 10 MB（压缩后）上限有大量余量。
 */
import type { BuiltinFontLoader } from "@unidocs/fonts-builtin";
import notoSans from "@unidocs/fonts-builtin/fonts/NotoSans-Regular.ttf";
import notoSansSC from "@unidocs/fonts-builtin/fonts/NotoSansSC-Regular.subset.otf";

/**
 * **两个 bundler 交出来的类型不同**，这件事本身才是这个函数存在的理由：
 * wrangler 的 `type = "Data"` 模块是 `ArrayBuffer`，本地栈 esbuild 的 `binary`
 * loader 是 `Uint8Array`。不归一的话，`BuiltinFontLoader` 声明返回 `Uint8Array`
 * 而生产 CF 上实际拿到 `ArrayBuffer` —— 消费者写 `.length` / `.subarray` / `[i]`
 * 会得到 `undefined` 或 TypeError，且**只在生产 CF 上出现，本地栈和测试都复现
 * 不了**。今天没炸只是因为 opentype.js 的 `parseBuffer` 自己做了归一。
 */
export const toBytes = (m: ArrayBuffer | Uint8Array): Uint8Array =>
  m instanceof Uint8Array ? m : new Uint8Array(m);

/** 键必须与 `BUILTIN_FONTS[].file` 一一对应，由 tests/builtin-fonts.test.ts 守住。 */
export const BYTES: Readonly<Record<string, ArrayBuffer | Uint8Array>> = Object.freeze({
  "NotoSans-Regular.ttf": notoSans,
  "NotoSansSC-Regular.subset.otf": notoSansSC,
});

export const builtinFontLoader: BuiltinFontLoader = async fileName => {
  const bytes = BYTES[fileName];
  // 打包配置漏了某个文件时，这里比「字体解析失败」好查得多。
  if (!bytes) throw new Error(`Builtin font ${fileName} was not bundled into the worker`);
  return toBytes(bytes);
};
