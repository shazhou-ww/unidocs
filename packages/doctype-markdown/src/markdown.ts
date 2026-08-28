/**
 * Markdown DocumentType implementation.
 */

import type { AgentToolDefinition, DocumentTypeFactory } from "@unidocs/protocol";
import { instructions, tools } from "./agent.js";
import type { MDoc, MQuery, MOp } from "./types.js";

export type MarkdownDocumentTypeFactory = DocumentTypeFactory<MDoc, MQuery, MOp>;

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

export const createMarkdownDocumentType: MarkdownDocumentTypeFactory = (_context) => ({
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

  formats: {
    markdown: {
      mediaTypes: ["text/markdown", "text/markdown; charset=utf-8"],
      extensions: [".md", ".markdown"],
      load: async (data) => ({ content: new TextDecoder().decode(data) }),
      save: async (doc) => new TextEncoder().encode(doc.content),
    },
  },
  defaultFormat: "markdown",

  contentType: "text/markdown; charset=utf-8",

  // `DocumentType.tools` is still typed as `Record<string, AgentToolDefinition>`
  // (spec's old shape); `tools` here is the new `AgentTool[]` table from
  // `agent.ts` (Task 8). The field is dead — nothing reads `DocumentType.tools`
  // any more, `markdownAgent` is the only consumer — and Task 10 deletes it
  // outright (same situation as
  // doctype-docx's `docx.ts`, which carries the identical narrow cast so as
  // not to lose contextual parameter typing on `query`/`apply` above).
  tools: tools as unknown as Record<string, AgentToolDefinition>,

  instructions,
});
