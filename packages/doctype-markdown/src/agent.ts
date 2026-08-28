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
import type { AgentTool, JsonValue, SValueType } from "@unidocs/protocol";
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
