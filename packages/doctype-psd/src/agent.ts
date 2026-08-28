/**
 * PSD DocumentAgent — a plain data table of tools plus a system prompt.
 *
 * Accepts no handle at all: each tool declares whether it reads or writes,
 * and the kernel (AgentSession) is the only thing that ever calls the
 * platform (spec 5.1). PSD doesn't know what an LLM provider or a CAS
 * looks like — it only produces queries/ops from arguments and, for
 * getPreview, turns a query result into an image content part.
 */
import type { DocumentAgent } from "@unidocs/doctype-server-common/agent";
import type { JsonValue, LegacyDocumentAgentFactory } from "@unidocs/protocol";
import { toJsonValue } from "@unidocs/svalue-codec";
import { instructions, tools } from "./tools.js";
import type { PsdOp } from "./ops/index.js";
import type { PsdQuery } from "./queries.js";

export const psdAgent: DocumentAgent<PsdQuery, PsdOp> = { tools, instructions };

export type PsdDocumentAgentFactory = LegacyDocumentAgentFactory<PsdQuery, PsdOp>;

/**
 * @deprecated 只为让 cloudflare-psd 的旧 OperatorDO 撑到内核切换那一步，
 * 下一个任务连同旧 OperatorDO 一起删。新代码用 psdAgent。
 *
 * 薄适配器：按工具的 kind 分发到它的 toQuery/toOps，再调旧上下边界的
 * context.query/apply。不复用 tools 表以外的任何东西 —— 新旧两套只有
 * "工具叫什么、是读是写、参数怎么变成 query/op" 这一份数据源。
 */
export const createPsdDocumentAgent: PsdDocumentAgentFactory = context => ({
  tools: Object.fromEntries(tools.map(t => [t.name, { name: t.name, description: t.description, inputSchema: t.inputSchema }])),
  instructions,

  async toolCall(name, parameters) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`Unknown PSD agent tool: ${name}`);
    const args = requireJsonObject(parameters);

    if (tool.kind === "query") {
      const result = await context.query(tool.toQuery(args));
      if (tool.toResult) return tool.toResult(result.data, result.version);
      // Same shape as the kernel's defaultQueryToolResult (session.ts) —
      // duplicated here rather than imported because this file may only
      // `import type` from doctype-server-common.
      return { structuredContent: toJsonValue({ data: result.data, version: result.version }) };
    }

    const result = await context.apply(tool.toOps(args), `Agent: ${name}`);
    return { structuredContent: { success: true, version: result.version } };
  },
});

function requireJsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent tool parameters must be a JSON object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}
