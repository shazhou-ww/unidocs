/**
 * Markdown DocumentAgent — a plain data table of tools plus a system prompt.
 *
 * Same shape as doctype-psd (see ../doctype-psd/src/tools.ts + agent.ts):
 * each tool declares whether it reads or writes, and the kernel
 * (AgentSession) is the only thing that ever calls the platform (spec 5.1).
 * Markdown doesn't know what an LLM provider or a CAS looks like — it only
 * produces queries/ops from arguments.
 */
import type { DocumentAgent } from "@unidocs/doctype-server-common/agent";
import type {
  AgentTool, JsonValue, LegacyDocumentAgentFactory, SValueType,
} from "@unidocs/protocol";
import { toJsonValue } from "@unidocs/svalue-codec";
import type { MOp, MQuery } from "./types.js";

/**
 * `toQuery` for the read tools: {} never masks a default, so an
 * argument-less call comes out as `{kind}` rather than `{kind, payload:{}}`.
 */
const mQuery = (kind: string) =>
  (args: Readonly<Record<string, JsonValue>>) =>
    (Object.keys(args).length === 0 ? { kind } : { kind, payload: args }) as unknown as SValueType<MQuery>;

/** `toOps` for the write tools: the model's arguments become the op payload verbatim. */
const mOp = (kind: string) =>
  (args: Readonly<Record<string, JsonValue>>) =>
    [{ kind, payload: args }] as unknown as readonly SValueType<MOp>[];

export const tools: readonly AgentTool<MQuery, MOp>[] = [
  {
    kind: "query",
    name: "getContent",
    description: "Get the full markdown content",
    inputSchema: { type: "object", properties: {} },
    toQuery: mQuery("getContent"),
  },
  {
    kind: "query",
    name: "getSection",
    description: "Get a specific section by heading",
    inputSchema: {
      type: "object",
      properties: { heading: { type: "string" } },
      required: ["heading"],
    },
    toQuery: mQuery("getSection"),
  },
  {
    kind: "query",
    name: "getHeadings",
    description: "List all headings in the document",
    inputSchema: { type: "object", properties: {} },
    toQuery: mQuery("getHeadings"),
  },
  {
    kind: "op",
    name: "setContent",
    description: "Replace the entire document content",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
    toOps: mOp("setContent"),
  },
  {
    kind: "op",
    name: "appendSection",
    description: "Append a new section with heading and content",
    inputSchema: {
      type: "object",
      properties: {
        heading: { type: "string" },
        content: { type: "string" },
      },
      required: ["heading", "content"],
    },
    toOps: mOp("appendSection"),
  },
  {
    kind: "op",
    name: "replaceSection",
    description: "Replace the content of an existing section",
    inputSchema: {
      type: "object",
      properties: {
        heading: { type: "string" },
        content: { type: "string" },
      },
      required: ["heading", "content"],
    },
    toOps: mOp("replaceSection"),
  },
  {
    kind: "op",
    name: "deleteSection",
    description: "Delete a section by heading",
    inputSchema: {
      type: "object",
      properties: { heading: { type: "string" } },
      required: ["heading"],
    },
    toOps: mOp("deleteSection"),
  },
];

export const instructions = `You are a Markdown document operator. You have tools to query and edit markdown documents.

When editing:
- Use getContent to see the full document
- Use getHeadings to understand structure
- Use getSection to read specific sections
- Use appendSection to add new sections
- Use replaceSection to modify existing sections
- Use deleteSection to remove sections

Be precise with heading names (case-insensitive matching).`;

export const markdownAgent: DocumentAgent<MQuery, MOp> = { tools, instructions };

export type MarkdownDocumentAgentFactory = LegacyDocumentAgentFactory<MQuery, MOp>;

/**
 * @deprecated 只为让 cloudflare-markdown 的旧 OperatorDO 撑到内核切换那一步，
 * 下一个任务连同旧 OperatorDO 一起删。新代码用 markdownAgent。
 *
 * 薄适配器：按工具的 kind 分发到它的 toQuery/toOps，再调旧上下边界的
 * context.query/apply。不复用 tools 表以外的任何东西 —— 新旧两套只有
 * "工具叫什么、是读是写、参数怎么变成 query/op" 这一份数据源。
 */
export const createMarkdownDocumentAgent: MarkdownDocumentAgentFactory = context => ({
  tools: Object.fromEntries(tools.map(t => [t.name, { name: t.name, description: t.description, inputSchema: t.inputSchema }])),
  instructions,

  async toolCall(name, parameters) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`Unknown Markdown agent tool: ${name}`);
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
