/**
 * 兼容再导出。这个函数只解析 pathname，没有一个 Cloudflare 类型 ——
 * 它属于云中立的 @unidocs/http-protocol，因为 azure-gateway 也要用同一份允许列表，
 * 而 Azure 侧不该依赖 Cloudflare 适配包。
 */
export { isPublicCasRoute } from "@unidocs/http-protocol";
