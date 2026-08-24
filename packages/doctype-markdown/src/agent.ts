import { toJsonValue } from "@unidocs/doctype-server-common";
import type { AgentToolDefinition, DocumentAgentFactory, JsonValue } from "@unidocs/protocol";
import type { MOp, MQuery } from "./types.js";

export type MarkdownDocumentAgentFactory = DocumentAgentFactory<MQuery, MOp>;

export const markdownTools: Readonly<Record<string, AgentToolDefinition>> = {
  getContent: {
    name: "query_getContent",
    description: "Get the full markdown content",
    inputSchema: {},
  },
  getSection: {
    name: "query_getSection",
    description: "Get a specific section by heading",
    inputSchema: {
      type: "object",
      properties: { heading: { type: "string" } },
      required: ["heading"],
    },
  },
  getHeadings: {
    name: "query_getHeadings",
    description: "List all headings in the document",
    inputSchema: {},
  },
  setContent: {
    name: "apply_setContent",
    description: "Replace the entire document content",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  appendSection: {
    name: "apply_appendSection",
    description: "Append a new section with heading and content",
    inputSchema: {
      type: "object",
      properties: {
        heading: { type: "string" },
        content: { type: "string" },
      },
      required: ["heading", "content"],
    },
  },
  replaceSection: {
    name: "apply_replaceSection",
    description: "Replace the content of an existing section",
    inputSchema: {
      type: "object",
      properties: {
        heading: { type: "string" },
        content: { type: "string" },
      },
      required: ["heading", "content"],
    },
  },
  deleteSection: {
    name: "apply_deleteSection",
    description: "Delete a section by heading",
    inputSchema: {
      type: "object",
      properties: { heading: { type: "string" } },
      required: ["heading"],
    },
  },
};

export const markdownInstructions = `You are a Markdown document operator. You have tools to query and edit markdown documents.

When editing:
- Use getContent to see the full document
- Use getHeadings to understand structure
- Use getSection to read specific sections
- Use appendSection to add new sections
- Use replaceSection to modify existing sections
- Use deleteSection to remove sections

Be precise with heading names (case-insensitive matching).`;

const toolsByName = new Set(Object.values(markdownTools).map(tool => tool.name));

export const createMarkdownDocumentAgent: MarkdownDocumentAgentFactory = context => ({
  tools: markdownTools,
  instructions: markdownInstructions,

  async toolCall(name, parameters) {
    if (!toolsByName.has(name)) throw new Error(`Unknown Markdown agent tool: ${name}`);
    const args = requireJsonObject(parameters);

    if (name.startsWith("query_")) {
      const kind = name.slice("query_".length);
      const query = Object.keys(args).length === 0
        ? { kind }
        : { kind, payload: args };
      const result = await context.query(query as unknown as MQuery);
      return {
        structuredContent: toJsonValue({
          data: result.data,
          version: result.version,
        }),
      };
    }

    if (name.startsWith("apply_")) {
      const operation = {
        kind: name.slice("apply_".length),
        payload: args,
      } as unknown as MOp;
      const result = await context.apply([operation], `Agent: ${name}`);
      return {
        structuredContent: {
          success: true,
          version: result.version,
        },
      };
    }

    throw new Error(`Unsupported Markdown agent tool: ${name}`);
  },
});

function requireJsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent tool parameters must be a JSON object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}