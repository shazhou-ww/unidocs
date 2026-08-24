/**
 * Azure/Node entry point for the Markdown document type.
 *
 * 除了「哪个 doc type」之外的一切都在
 * `@unidocs/azure-sdk` 的 `runDocTypeService()` 里 —— 连接池与它的四个
 * 超时、Blob 客户端、端口构造、每请求新建 DocumentSession、CAS 接线、
 * 优雅关停。docx 的入口（packages/azure-docx）与本文件形状相同：这是
 * 刻意的，任何在两边都要改一遍的东西都该往 SDK 里搬，而不是复制。
 *
 * Env vars: DATABASE_URL, INTERNAL_TOKEN, PORT，加上一组二选一的 Blob 配置：
 * 云上是 BLOB_ACCOUNT_URL + AZURE_CLIENT_ID（用户分配托管标识；漏掉后者
 * 容器能起来、能过健康检查，第一次 Blob 操作才炸，所以 resolveBlobConfig()
 * 把它作为启动期硬性要求），本地/Azurite 是 BLOB_CONNECTION_STRING。
 * CAS_BASE_URL 可选（过渡形态，见 doc-type-service.ts）。
 */
import { runDocTypeService } from "@unidocs/azure-sdk";
import { createMarkdownDocumentType } from "@unidocs/doctype-markdown";

runDocTypeService({
  docType: "markdown",
  documentType: createMarkdownDocumentType({
    makeSBlob: async () => { throw new Error("makeSBlob not available in azure-markdown"); },
    readSBlob: async () => { throw new Error("readSBlob not available in azure-markdown"); },
  } as any),
  defaultPort: 41800,
}).catch((err) => {
  console.error("azure-markdown failed to start:", err);
  process.exit(1);
});
