/**
 * Markdown DocumentType implementation.
 */

import type { DocumentTypeFactory } from "@unidocs/core";
import type { MDoc, MQuery, MOp } from "./types.js";

export type MarkdownOptions = Record<string, never>;
export type MarkdownDocumentTypeFactory = DocumentTypeFactory<MarkdownOptions, MDoc, MQuery, MOp>;

/** Helper: extract section by heading (case-insensitive, supports nested headings). */
function getSection(content: string, heading: string): string | null {
  const lines = content.split("\n");
  const headingPattern = new RegExp(`^#{1,6}\\s+${escapeRegex(heading)}\\s*$`, "i");
  let startIdx = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)\s*$/);
    if (match && headingPattern.test(lines[i])) {
      startIdx = i;
      startLevel = match[1].length;
      break;
    }
  }

  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= startLevel) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join("\n");
}

/** Helper: extract all headings. */
function getHeadings(content: string): string[] {
  const lines = content.split("\n");
  const headings: string[] = [];
  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+)\s*$/);
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const createMarkdownDocumentType: MarkdownDocumentTypeFactory = (_options) => ({
  init: async () => ({ content: "" }),

  query: async (q, doc) => {
    switch (q.kind) {
      case "getContent":
        return doc.content;
      case "getSection":
        return getSection(doc.content, q.payload.heading);
      case "getHeadings":
        return getHeadings(doc.content);
    }
  },

  apply: async (operations, doc) => {
    let content = doc.content;

    for (const op of operations) {
      switch (op.kind) {
        case "setContent":
          content = op.payload.content;
          break;
        case "appendSection":
          content += `\n\n## ${op.payload.heading}\n\n${op.payload.content}`;
          break;
        case "replaceSection": {
          const section = getSection(content, op.payload.heading);
          if (!section) throw new Error(`Section not found: ${op.payload.heading}`);
          content = content.replace(section, `## ${op.payload.heading}\n\n${op.payload.content}`);
          break;
        }
        case "deleteSection": {
          const section = getSection(content, op.payload.heading);
          if (!section) throw new Error(`Section not found: ${op.payload.heading}`);
          content = content.replace(section, "");
          break;
        }
      }
    }

    return { content };
  },

  load: async (data) => ({ content: new TextDecoder().decode(data) }),
  save: async (doc) => new TextEncoder().encode(doc.content),
  contentType: "text/markdown; charset=utf-8",

  // Markdown snapshots are self-contained text, no CAS references.
  refsFromSnapshot: () => ({}),
  refsFromOp: () => ({}),

  tools: {
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
  },

  instructions: `You are a Markdown document operator. You have tools to query and edit markdown documents.

When editing:
- Use getContent to see the full document
- Use getHeadings to understand structure
- Use getSection to read specific sections
- Use appendSection to add new sections
- Use replaceSection to modify existing sections
- Use deleteSection to remove sections

Be precise with heading names (case-insensitive matching).`,
});
