import { Document } from "@ariadng/office/docx";
import type { DocumentTypeFactory, QueryValue } from "@unidocs/core";
import type {
  DocxDoc,
  DocxOperation,
  DocxParagraphOptions,
  DocxQuery,
} from "./types.js";

export type DocxOptions = Record<string, never>;
export type DocxDocumentTypeFactory = DocumentTypeFactory<
  DocxOptions,
  DocxDoc,
  DocxQuery,
  DocxOperation
>;

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function requireIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function paragraphValue(doc: DocxDoc, index: number): QueryValue | null {
  requireIndex(index, "paragraph index");
  const paragraph = doc.document.paragraphs()[index];
  if (!paragraph) return null;

  return {
    index,
    text: paragraph.text(),
    styleId: paragraph.styleId() ?? null,
    runs: paragraph.runs().map((run, runIndex) => ({
      index: runIndex,
      text: run.text(),
      bold: run.bold(),
      italic: run.italic(),
    })),
  };
}

async function createState(document: Document): Promise<DocxDoc> {
  return { bytes: await document.save(), document };
}

function appendParagraph(document: Document, text: string, options?: DocxParagraphOptions): void {
  document.addParagraph(text, options);
}

function setRunText(
  document: Document,
  paragraphIndex: number,
  runIndex: number,
  text: string,
): void {
  requireIndex(paragraphIndex, "paragraphIndex");
  requireIndex(runIndex, "runIndex");

  const paragraph = document.paragraphs()[paragraphIndex];
  if (!paragraph) throw new RangeError(`Paragraph ${paragraphIndex} not found`);

  const run = paragraph.runs()[runIndex];
  if (!run) throw new RangeError(`Run ${runIndex} not found in paragraph ${paragraphIndex}`);
  run.setText(text);
}

export const createDocxDocumentType: DocxDocumentTypeFactory = (_options) => ({
  init: async () => createState(Document.create()),

  query: async (query, doc) => {
    switch (query.kind) {
      case "getText":
        return doc.document.text();
      case "getParagraphs":
        return doc.document.paragraphs().map((_, index) => paragraphValue(doc, index)!);
      case "getParagraph":
        return paragraphValue(doc, query.payload.index);
    }
  },

  apply: async (operations, doc) => {
    const working = await Document.open(doc.bytes);

    for (const operation of operations) {
      switch (operation.kind) {
        case "appendParagraph":
          appendParagraph(working, operation.payload.text, operation.payload.options);
          break;
        case "setRunText":
          setRunText(
            working,
            operation.payload.paragraphIndex,
            operation.payload.runIndex,
            operation.payload.text,
          );
          break;
      }
    }

    return createState(working);
  },

  load: async (data) => {
    const bytes = data.slice();
    return { bytes, document: await Document.open(bytes) };
  },

  save: async (doc) => doc.bytes.slice(),
  contentType: DOCX_CONTENT_TYPE,

  tools: {
    getText: {
      name: "query_getText",
      description: "Get the document's plain text",
      inputSchema: {},
    },
    getParagraphs: {
      name: "query_getParagraphs",
      description: "List paragraphs with styles and text runs",
      inputSchema: {},
    },
    getParagraph: {
      name: "query_getParagraph",
      description: "Get one paragraph by its zero-based index",
      inputSchema: {
        type: "object",
        properties: { index: { type: "integer", minimum: 0 } },
        required: ["index"],
      },
    },
    appendParagraph: {
      name: "apply_appendParagraph",
      description: "Append a paragraph to the document",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          options: {
            type: "object",
            properties: {
              style: { type: "string" },
              bold: { type: "boolean" },
              italic: { type: "boolean" },
            },
          },
        },
        required: ["text"],
      },
    },
    setRunText: {
      name: "apply_setRunText",
      description: "Replace the text of one run in a paragraph",
      inputSchema: {
        type: "object",
        properties: {
          paragraphIndex: { type: "integer", minimum: 0 },
          runIndex: { type: "integer", minimum: 0 },
          text: { type: "string" },
        },
        required: ["paragraphIndex", "runIndex", "text"],
      },
    },
  },

  instructions: `You are a DOCX document operator. Use query tools before editing so paragraph and run indexes are current.

The initial tool set is intentionally small:
- Use getText for a plain-text overview
- Use getParagraphs to inspect paragraph and run indexes
- Use getParagraph for one paragraph
- Use appendParagraph to add content
- Use setRunText to replace text while preserving that run's formatting

Indexes are zero-based. Re-query after edits because document structure may change.`,
});
