/**
 * `seed-psd-fonts.mjs` 要用的、只存在于 TypeScript 源码里的那几件东西的汇合点。
 *
 * 为什么需要一个中转文件：node 直接 import 这些包的 `src/index.ts` 会在第一条
 * `./x.js` 相对导入上炸 —— node 的类型擦除不做 `.js` → `.ts` 重写；而
 * `text/opentype-face.ts` 里的构造器参数属性连 strip-only 模式都过不去
 * （`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。仓库里已经有现成的解法：esbuild +
 * `resolveWorkspaceAliases`（见 `stacks/unidocs-cloudflare/local/runtime.mjs`
 * 的 `bundleWorker`）。脚本先把本文件打成一个 bundle 再 import 它。
 *
 * 单测和集成测试直接 import 本文件（vitest 自己转译 TS），所以打包那一步只发生
 * 在 CLI 上 —— 测试不依赖 esbuild 也就不会因为打包配置写错而变成假绿。
 *
 * 每一条都写成**相对源码路径**而不是包名：包的 `exports` 里 `import` 条件指向
 * `dist/`，走包名解析时到底拿到源码还是一份可能过期的构建产物，取决于跑它的是
 * vite 还是 esbuild。预置脚本要写进 CAS 的是不可变内容，解析器版本对不上会得到
 * 一份"哈希对不上任何东西"的索引，所以这里不留那个自由度。
 */
export { fontCoverage, parseFontFace } from "../packages/doctype-psd/src/text/opentype-face.js";
export { createCasBlobClient } from "../unicas-packages/tenant-blob-client/src/index.js";
export { createTenantCasClient } from "../unicas-packages/tenant-client/src/index.js";
export {
  casWritePermission,
  createPkcs8CapabilityIssuer,
  sessionCreatePermission,
} from "../packages/service-auth/src/index.js";
