/**
 * `docType` -> worker URL 解析,拆成独立文件的唯一原因是可测性:`main.ts`
 * 顶层无条件调用 `main().catch(...)`,导入它会真的去连 Postgres、起
 * HTTP server、装信号处理器——测试这条纯逻辑不该有这些副作用。
 */
import type { PgDocTypeRegistry } from "@unidocs/azure-sdk";

/**
 * 两级解析,与 Cloudflare 侧同形(`cloudflare-gateway/src/worker.ts` 先查
 * KV 的 `docType:{type}`、未命中再读环境变量)。
 *
 * 环境变量兜底保留给本地开发与临时调试:本地栈没有 Container Apps,服务
 * 不会注册,只能靠它。云上 `gateway.bicep` 不再设置这些变量 —— 若它去算
 * 那些地址,就得知道有哪些 doc type,耦合又回来了。
 */
export function makeResolveWorkerUrl(registry: PgDocTypeRegistry) {
  return async (docType: string): Promise<string | null> => {
    const fromRegistry = await registry.resolve(docType);
    if (fromRegistry) return fromRegistry;
    return process.env[`${docType.toUpperCase()}_WORKER_URL`] ?? null;
  };
}
