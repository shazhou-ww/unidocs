/**
 * Azure/Node entry point for the PSD document type.
 *
 * 与 `packages/azure-markdown` / `packages/azure-docx` 的入口同形,只有
 * doc type 与默认端口不同:连接池与它的四个超时、Blob 客户端、端口构造、
 * 每请求新建 DocumentSession、CAS 接线、SBlob 上下文、优雅关停,全部在
 * `@unidocs/azure-sdk` 的 `runDocTypeService()` 里。如果这个文件需要复制
 * 另两个入口里的任何东西,说明 SDK 抽取不完整 —— 改 azure-sdk,不要在这里抄。
 *
 * PSD 的像素路径重度依赖 SBlob,因此需要 CAS。本轮仍是过渡形态:
 * `CAS_BASE_URL` 指向 Cloudflare 的 CAS worker(阶段 4 换成 azure-cas)。
 * `azure.service.json` 里的 `needsCas: true` 声明了这一点,本地栈与部署
 * 脚本都从那里读。
 *
 * **Operator 已接，且带字体索引。** `documentAgent` 是按会话身份构造的工厂
 * （字体索引是租户级的，接线在 `agent-deps.ts`）。它与 `llmProvider` 同时提供时
 * `runDocTypeService()` 挂真 operator,历史落 Postgres(`PgAgentSessionStore`);
 * Azure 是 2-5 副本、无会话亲和,并发靠租约 + 409(抢不到锁就让调用方重试),
 * 不是 Cloudflare DO 那种单线程排队。
 *
 * Env vars: DATABASE_URL, CAS_STACK_ID, PORT,加上一组
 * 二选一的 Blob 配置:云上是 BLOB_ACCOUNT_URL + AZURE_CLIENT_ID(用户分配
 * 托管标识;漏掉后者容器能起来、能过健康检查,第一次 Blob 操作才炸,所以
 * resolveBlobConfig() 把它作为启动期硬性要求),本地/Azurite 是
 * BLOB_CONNECTION_STRING。CAS_BASE_URL 可选(过渡形态)，CAS 使用请求级
 * delegated capability，不再配置共享 CAS key。
 */
import { PgFontRegistry, requireEnv, runDocTypeService } from "@unidocs/azure-sdk";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";
import { consoleObserver } from "@unidocs/protocol-doc";
import { createPsdAgent, createPsdDocumentType } from "@unidocs/doctype-psd";
import { psdAgentDeps } from "./agent-deps.js";

runDocTypeService({
  docType: "psd",
  documentTypeFactory: createPsdDocumentType,
  defaultPort: 41820,
  // 接线本体在 `agent-deps.ts` —— 这里只负责调用。拆出去是为了能测：内联在
  // 入口里的接线只有一次带凭据的真实 `/run` 才会执行到，把回退链改坏、把
  // fontIndex 拿掉，整套单测照样全绿（CF 侧用注入法证实过）。
  // identity 与 pool 都由 SDK 在每次请求 / 启动后给：字体索引是租户级的，
  // 进程起来的这一刻既没有租户，也还没有连接池。
  documentAgent: (identity, pool) => createPsdAgent(psdAgentDeps(process.env, identity, pool)),
  llmProvider: createAnthropicProvider(process.env, fetch, { observe: consoleObserver }),
  // 租户级的 `/tenants/{t}/fonts`（预置脚本往这里登记字体）。只有 psd 挂它 ——
  // markdown/docx 没有字体索引。SDK 在 `createDocTypeHandler` 之前分流，因为
  // `matchDocRoute` 只认会话级路径。
  fontRegistryFor: (tenantId, pool) =>
    new PgFontRegistry(pool, { stackId: requireEnv("CAS_STACK_ID"), tenantId }),
}).catch((err) => {
  console.error("azure-psd failed to start:", err);
  process.exit(1);
});
