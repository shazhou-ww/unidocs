/**
 * `@unidocs/doctype-server-common/agent` —— 文档类型和平台 sdk 共同对着
 * 写代码的那一层。契约类型定义在 protocol，这里再导出一次，于是作者只
 * 需要记住一个 import 来源（spec 4.3.1）。
 */
export type {
  AgentCompletion, AgentContentPart, AgentMessage, AgentPlatform,
  AgentTool, AgentToolCall, AgentToolDefinition, AgentToolResult,
  DocumentAgent, LlmContentPart, LlmMessage, LlmProvider,
} from "@unidocs/protocol";

/** readBlob 的错误分类契约，和 AgentPlatform 同源。 */
export { BlobUnavailableError } from "@unidocs/protocol";

export {
  defaultOpToolResult, defaultQueryToolResult, toolResultToMessage,
} from "./tool-result.js";

export {
  ByteLru, materializeMessages,
} from "./messages.js";

export {
  AgentSession, DEFAULT_MAX_ITERATIONS,
} from "./session.js";
export { decodeHistory, encodeHistory } from "./history-codec.js";
export type { AgentRunOutcome, AgentSessionDeps } from "./session.js";

export { createHttpAgentPlatform } from "./platform-http.js";
export type { EditorFetcher, HttpAgentPlatformDeps } from "./platform-http.js";

export {
  createAnthropicProvider, toAnthropicMessages,
} from "./providers/anthropic.js";
export type { AnthropicMessage } from "./providers/anthropic.js";
