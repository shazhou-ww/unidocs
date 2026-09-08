/**
 * 字体文件被 bundler 变成一个默认导出的模块 —— 但**两个 bundler 交出来的类型
 * 不一样**：wrangler 的 `[[rules]] type = "Data"` 给的是 `ArrayBuffer`
 * （见 wrangler-dist/cli.js 的 `moduleTypeMap = { Data: "ArrayBuffer", … }`），
 * 本地栈 esbuild 的 `binary` loader 给的是 `Uint8Array`。
 *
 * 这里如实声明成两者的并集，归一交给 `builtin-fonts.ts` 的 `toBytes`。声明成
 * 单一类型的代价是一个**只在生产 CF 上出现、本地栈与测试都复现不了**的分歧。
 */
declare module "@unidocs/fonts-builtin/fonts/*" {
  const bytes: ArrayBuffer | Uint8Array;
  export default bytes;
}
