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
 * **Operator 在 Azure 上不可用。** `azure-sdk` 的
 * `createStubOperatorNamespace()` 让所有 doc type 的 `/run` 与 `/reset` 一律
 * 501。Cloudflare 侧 psd 挂了真 Operator(`createPsdAgent` +
 * Anthropic,maxIterations 25),Azure 侧没有。这不是 psd 特有的缺口,接真
 * Operator 会同时影响 markdown/docx/psd 三家,是独立一轮的事——不是这里漏掉了。
 *
 * Env vars: DATABASE_URL, CAS_STACK_ID, PORT,加上一组
 * 二选一的 Blob 配置:云上是 BLOB_ACCOUNT_URL + AZURE_CLIENT_ID(用户分配
 * 托管标识;漏掉后者容器能起来、能过健康检查,第一次 Blob 操作才炸,所以
 * resolveBlobConfig() 把它作为启动期硬性要求),本地/Azurite 是
 * BLOB_CONNECTION_STRING。CAS_BASE_URL 可选(过渡形态)，CAS 使用请求级
 * delegated capability，不再配置共享 CAS key。
 */
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createPsdDocumentType } from "@unidocs/doctype-psd";

runDocTypeService({
  docType: "psd",
  documentTypeFactory: createPsdDocumentType,
  defaultPort: 41820,
}).catch((err) => {
  console.error("azure-psd failed to start:", err);
  process.exit(1);
});
