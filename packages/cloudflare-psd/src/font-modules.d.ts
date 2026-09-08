/**
 * wrangler 的 `[[rules]] type = "Data"` 与 esbuild 的 `binary` loader 都把字体
 * 文件变成一个默认导出的字节数组。声明它，好让 tsc 认得这个 import —— 否则
 * `builtin-fonts.ts` 的两行 import 在 tsc 眼里是「找不到模块」。
 */
declare module "@unidocs/fonts-builtin/fonts/*" {
  const bytes: Uint8Array;
  export default bytes;
}
