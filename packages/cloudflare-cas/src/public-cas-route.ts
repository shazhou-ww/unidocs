/**
 * 兼容再导出。这个函数只解析 pathname，没有一个 Cloudflare 类型 ——
 * 它属于 CAS 自有的云中立协议包，因为 azure-gateway 也要用同一份允许列表，
 * 而 Azure 侧不该依赖 Cloudflare 适配包。
 */
export { isPublicCasRoute } from "@unidocs/protocol-cas";
