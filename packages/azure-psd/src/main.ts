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
 * **Operator 已接。** `documentAgent` 与 `llmProvider` 同时提供时
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
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";
import { consoleObserver } from "@unidocs/protocol-doc";
import { createPsdAgent, createPsdDocumentType, createQwenImageEditor } from "@unidocs/doctype-psd";

runDocTypeService({
  docType: "psd",
  documentTypeFactory: createPsdDocumentType,
  defaultPort: 41820,
  // 与 Cloudflare 的条件化同形(cloudflare-psd/src/worker.ts:36-52):没有 key
  // 就不注入 editor,于是工具表里没有 editPixels、提示词里也没有。
  // doctype-psd/src/agent.ts:23-26 记着这条的由来 —— 只条件化其中一个会得到一个
  // "提示词里有、工具表里没有"的幽灵工具,那是线上真实发生过的故障。
  // 值改成工厂：本任务只对齐签名，真正让它按会话身份接 fontIndex 是下一个
  // 任务的事（那时 identity 会被用上；这里先原样忽略它）。
  documentAgent: () => createPsdAgent(
    process.env.IMAGE_EDIT_API_KEY
      ? {
        editor: createQwenImageEditor({
          apiKey: process.env.IMAGE_EDIT_API_KEY,
          observe: consoleObserver,
          ...(process.env.IMAGE_EDIT_MODEL ? { model: process.env.IMAGE_EDIT_MODEL } : {}),
          ...(process.env.IMAGE_EDIT_BASE_URL ? { baseUrl: process.env.IMAGE_EDIT_BASE_URL } : {}),
        }),
      }
      : {},
  ),
  llmProvider: createAnthropicProvider(process.env, fetch, { observe: consoleObserver }),
}).catch((err) => {
  console.error("azure-psd failed to start:", err);
  process.exit(1);
});
