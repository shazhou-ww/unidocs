/**
 * Tool definitions and operator instructions for the DOCX document type.
 */

import type { DocumentTypeFactory } from "@unidocs/core";
import type { DocxDoc, DocxQuery, DocxOperation } from "./types.js";

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolsMap = Record<string, ToolDef>;

export const tools: ToolsMap = {
  // ─── Queries ─────────────────────────────────────────────────────
  getText: {
    name: "query_getText",
    description: "Get the document's plain text content",
    inputSchema: {},
  },
  getParagraphs: {
    name: "query_getParagraphs",
    description: "List all paragraphs with styles and text runs",
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
  getTables: {
    name: "query_getTables",
    description: "List all tables with dimensions (rows, cols) and style",
    inputSchema: {},
  },
  getTable: {
    name: "query_getTable",
    description: "Get one table by index, including all rows and cell text",
    inputSchema: {
      type: "object",
      properties: { index: { type: "integer", minimum: 0 } },
      required: ["index"],
    },
  },
  getHeaders: {
    name: "query_getHeaders",
    description: "List document headers with type and text",
    inputSchema: {},
  },
  getFooters: {
    name: "query_getFooters",
    description: "List document footers with type and text",
    inputSchema: {},
  },

  // ─── Paragraph operations ────────────────────────────────────────
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
    description: "Replace the text of one run in a paragraph, preserving its formatting",
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

  // ─── Table operations ────────────────────────────────────────────
  addTable: {
    name: "apply_addTable",
    description: "Add a table with the given number of rows and columns",
    inputSchema: {
      type: "object",
      properties: {
        rows: { type: "integer", minimum: 1 },
        cols: { type: "integer", minimum: 1 },
        style: { type: "string", description: "Table style id, e.g. 'TableGrid'" },
      },
      required: ["rows", "cols"],
    },
  },
  setCellText: {
    name: "apply_setCellText",
    description: "Set the text of a specific table cell",
    inputSchema: {
      type: "object",
      properties: {
        tableIndex: { type: "integer", minimum: 0 },
        row: { type: "integer", minimum: 0 },
        col: { type: "integer", minimum: 0 },
        text: { type: "string" },
      },
      required: ["tableIndex", "row", "col", "text"],
    },
  },
  addTableRow: {
    name: "apply_addTableRow",
    description: "Add a row to a table, copying cell formatting from the last row",
    inputSchema: {
      type: "object",
      properties: {
        tableIndex: { type: "integer", minimum: 0 },
      },
      required: ["tableIndex"],
    },
  },

  // ─── List operations ─────────────────────────────────────────────
  addBulletList: {
    name: "apply_addBulletList",
    description: "Add a bullet list. Items are level-0 unless given as { text, level }.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  text: { type: "string" },
                  level: { type: "integer", minimum: 0, maximum: 8 },
                },
                required: ["text", "level"],
              },
            ],
          },
        },
      },
      required: ["items"],
    },
  },
  addNumberedList: {
    name: "apply_addNumberedList",
    description: "Add a numbered list. Format options: decimal, lowerLetter, upperLetter, lowerRoman, upperRoman.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  text: { type: "string" },
                  level: { type: "integer", minimum: 0, maximum: 8 },
                },
                required: ["text", "level"],
              },
            ],
          },
        },
        format: {
          type: "string",
          enum: ["decimal", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman"],
        },
      },
      required: ["items"],
    },
  },

  // ─── Section operations ──────────────────────────────────────────
  setHeader: {
    name: "apply_setHeader",
    description: "Set the document header. Type: 'default' (all pages), 'first', or 'even'.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        type: { type: "string", enum: ["default", "first", "even"] },
      },
      required: ["text"],
    },
  },
  setFooter: {
    name: "apply_setFooter",
    description: "Set the document footer. Type: 'default' (all pages), 'first', or 'even'.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        type: { type: "string", enum: ["default", "first", "even"] },
      },
      required: ["text"],
    },
  },
};

export const instructions = `You are a DOCX document operator. Use query tools before editing so indexes are current.

## Query tools
- getText — plain-text overview of the document
- getParagraphs — list all paragraphs with style, runs, and formatting
- getParagraph — inspect one paragraph by index
- getTables — list all tables with dimensions and style
- getTable — full table detail including every row and cell
- getHeaders / getFooters — inspect document headers and footers

## Edit tools — paragraphs
- appendParagraph — add a paragraph (optionally with style, bold, italic)
- setRunText — replace text of one run, preserving its formatting

## Edit tools — tables
- addTable — insert a new table (rows × cols, optional style)
- setCellText — set text in a specific cell (tableIndex, row, col)
- addTableRow — append a row to a table (copies formatting from last row)

## Edit tools — lists
- addBulletList — add a bullet list (items can be strings or { text, level })
- addNumberedList — add a numbered list (items + optional format)

## Edit tools — sections
- setHeader — set document header (type: default/first/even)
- setFooter — set document footer (type: default/first/even)

## Rules
- Indexes are zero-based.
- Always re-query after edits because document structure may change.
- Use getParagraphs to find paragraph and run indexes before editing.
- Use getTables to find table indexes before editing cells.
- When building tables, addTable first, then setCellText for each cell.`;
