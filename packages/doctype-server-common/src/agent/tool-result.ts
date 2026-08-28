import { toJsonValue } from "@unidocs/svalue-codec";
import type { AgentMessage, AgentToolResult, SValue } from "@unidocs/protocol";

/**
 * `kind: "query"` 未提供 toResult 时的默认转换。
 * 签名与 AgentTool.toResult 完全一致 —— 不写 toResult 就等于用了这个。
 *
 * 只有内核调。一个工具但凡写了 toResult，就说明默认满足不了它，不存在
 * "先调默认再往上加"的用法，所以它留在内核，文档类型一次都不 import
 * （spec 5.1.2）。
 */
export function defaultQueryToolResult(data: SValue, version: number): AgentToolResult {
  return { structuredContent: toJsonValue({ data, version } as SValue) };
}

/** `kind: "op"` 的固定转换。op 工具没有 toResult，这条不可覆盖。 */
export function defaultOpToolResult(version: number): AgentToolResult {
  return { structuredContent: { success: true, version } };
}

/**
 * AgentToolResult → AgentMessage 的无损结构转换。
 *
 * AgentToolResult 是**中转类型**：只活在"工具返回"到这里为止，进不了
 * 历史、数据库和事件流，落盘的一律是 AgentMessage（spec 5.4.1）。
 */
export function toolResultToMessage(callId: string, result: AgentToolResult): AgentMessage {
  return {
    role: "tool",
    callId,
    content: result.content ?? [],
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
  };
}
