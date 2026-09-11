export { PlatformError, toPlatformError } from "./errors.js";
export type { PlatformErrorCodeOrUnknown } from "./errors.js";
export type { PlatformRequest, PlatformResponse, PlatformTransport, QueryValue } from "./transport.js";
export { createTenantPortalClient } from "./client.js";
export type { TenantPortalClient } from "./client.js";
export { createHttpTransport } from "./http-transport.js";
export {
  createMarkdownTextRange,
  MarkdownDocumentType,
  MarkdownTextRangeLocationType,
  readMarkdownTextRange,
  resolveMarkdownTextRange,
} from "./doctypes/markdown.js";
export type {
  MarkdownRangeResolution,
  MarkdownSnapshot,
  MarkdownTextRangePayload,
} from "./doctypes/markdown.js";
export { createMemoryStore, isOpen } from "./memory/store.js";
export type { MemorySeed, MemoryStore, SeedDocument, SeedPing, SeedPong, SeedThread } from "./memory/store.js";
export { createMemoryTransport } from "./memory/transport.js";
export { createScriptedAgent } from "./memory/agent.js";
export type { AgentContext, AgentReply, ScriptedAgent } from "./memory/agent.js";
export { rangeOf, sampleSeed } from "./memory/seed.js";
