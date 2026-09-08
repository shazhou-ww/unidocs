export * from "./pool.js";
export * from "./migrate.js";
export * from "./ports-pg.js";
export * from "./ports-blob.js";
export * from "./font-provider-pg.js";
export * from "./http-shell.js";
export * from "./env.js";
export * from "./local-editor.js";
export * from "./doc-type-service.js";
export * from "./legacy-session-import.js";
export { AGENT_LEASE_SECONDS, PgAgentSessionStore } from "./agent-session-store.js";
export { createLocalOperatorNamespace } from "./local-operator.js";
export type { LocalOperatorDeps } from "./local-operator.js";

/**
 * 与 `@unidocs/cloudflare-sdk` 的同名再导出对称：doc type 的 Azure 入口
 * （`azure-psd/src/agent-deps.ts` 的 `blobFor`）要把一个内容哈希变成可读的
 * `SBlob`，而它不该为此单独依赖编解码包 —— 平台 SDK 是它唯一的运行时入口。
 */
export { createSBlob } from "@unidocs/svalue-codec";
