/**
 * 兼容层。实现已提到 `@unidocs/doctype-server-common/agent` 供两条运行时共用
 * （见那边的 `platform-http.ts`）；这里保留旧名字，让 `operator-do-agent.ts`
 * 的调用点一个字都不用改。
 */
export {
  createHttpAgentPlatform as createCloudflareAgentPlatform,
} from "@unidocs/doctype-server-common/agent";
export type {
  HttpAgentPlatformDeps as CloudflarePlatformDeps,
} from "@unidocs/doctype-server-common/agent";
