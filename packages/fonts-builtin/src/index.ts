/**
 * 随安装包发行的默认字体。
 *
 * 它存在的理由是「即装即用」：在它之前，`setText` 能不能工作取决于有没有人对着
 * 这个环境、这个租户跑过一次 `scripts/seed-psd-fonts.mjs`。没跑过的表现不是报错，
 * 是中文层整层画不出来。
 *
 * 字节随包走、不进 CAS，所以它对应的 provider `blobFor()` 返回 null，
 * 排出来的字也不进 `doc.fonts` —— 没有可回收的对象，不需要保活。
 */
export type { BuiltinFontRecord } from "./types.js";
export { BUILTIN_FONTS } from "./fonts.generated.js";
