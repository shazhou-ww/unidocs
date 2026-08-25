/**
 * Tool definitions and operator instructions for the DOCX document type.
 */

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
  getParagraphFormat: {
    name: "query_getParagraphFormat",
    description: "Get the effective formatting Word renders for one paragraph",
    inputSchema: {
      type: "object",
      properties: { paragraphIndex: { type: "integer", minimum: 0 } },
      required: ["paragraphIndex"],
    },
  },
  getRunFormat: {
    name: "query_getRunFormat",
    description: "Get the effective formatting Word renders for one text run",
    inputSchema: {
      type: "object",
      properties: {
        paragraphIndex: { type: "integer", minimum: 0 },
        runIndex: { type: "integer", minimum: 0 },
      },
      required: ["paragraphIndex", "runIndex"],
    },
  },
  getParagraphList: {
    name: "query_getParagraphList",
    description: "Get resolved list metadata for one paragraph, or null if it is not a list item",
    inputSchema: {
      type: "object",
      properties: { paragraphIndex: { type: "integer", minimum: 0 } },
      required: ["paragraphIndex"],
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
  getImages: {
    name: "query_getImages",
    description: "List inline and anchored images (index, format, partName, size). Does not return CAS hashes.",
    inputSchema: {},
  },
  getImage: {
    name: "query_getImage",
    description: "Get one image by its zero-based index",
    inputSchema: {
      type: "object",
      properties: { index: { type: "integer", minimum: 0 } },
      required: ["index"],
    },
  },
  getImageByPartName: {
    name: "query_getImageByPartName",
    description: "Find an image by its part name (e.g. '/word/media/image1.png')",
    inputSchema: {
      type: "object",
      properties: { partName: { type: "string" } },
      required: ["partName"],
    },
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
        widthsTwips: {
          type: "array",
          description: "Positive column widths in twips; length must equal cols",
          items: { type: "number", exclusiveMinimum: 0 },
        },
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

  // ─── Image operations ────────────────────────────────────────────
  insertImage: {
    name: "apply_insertImage",
    description:
      "Append an inline image. The hash must already be uploaded through the authenticated Gateway CAS API (PNG or JPEG).",
    inputSchema: {
      type: "object",
      properties: {
        hash: { type: "string", minLength: 64, maxLength: 64 },
        widthPx: { type: "number", exclusiveMinimum: 0 },
        altText: { type: "string" },
      },
      required: ["hash"],
    },
  },
  deleteImage: {
    name: "apply_deleteImage",
    description: "Delete an image by its zero-based index",
    inputSchema: {
      type: "object",
      properties: { index: { type: "integer", minimum: 0 } },
      required: ["index"],
    },
  },
  replaceImage: {
    name: "apply_replaceImage",
    description: "Replace an image's bytes with new content from CAS. The hash must already be uploaded.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0 },
        hash: { type: "string", minLength: 64, maxLength: 64 },
      },
      required: ["index", "hash"],
    },
  },
  setImageSize: {
    name: "apply_setImageSize",
    description: "Set the display size of an image (in EMU: 914400 EMU = 1 inch)",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0 },
        widthEmu: { type: "integer", exclusiveMinimum: 0 },
        heightEmu: { type: "integer", exclusiveMinimum: 0 },
      },
      required: ["index"],
    },
  },
  setImageAltText: {
    name: "apply_setImageAltText",
    description: "Set the alt text (description) of an image",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0 },
        altText: { type: "string" },
      },
      required: ["index", "altText"],
    },
  },
};

export const instructions = `You are a DOCX document operator. Use query tools before editing so indexes are current.

## Query tools
- getText — plain-text overview of the document
- getParagraphs — list all paragraphs with style, runs, and formatting
- getParagraph — inspect one paragraph by index
- getParagraphFormat — resolve paragraph formatting through Word's style cascade
- getRunFormat — resolve run formatting through Word's style cascade
- getParagraphList — inspect resolved bullet/numbering metadata
- getTables — list all tables with dimensions and style
- getTable — full table detail including every row and cell
- getHeaders / getFooters — inspect document headers and footers
- getImages — list embedded images (index, format, partName, display size)
- getImage — get one image by index
- getImageByPartName — find an image by its part name (e.g. '/word/media/image1.png')

## Edit tools — paragraphs
- appendParagraph — add a paragraph (optionally with style, bold, italic)
- setRunText — replace text of one run, preserving its formatting

## Edit tools — tables
- addTable — insert a new table (rows × cols, optional style and column widths)
- setCellText — set text in a specific cell (tableIndex, row, col)
- addTableRow — append a row to a table (copies formatting from last row)

## Edit tools — lists
- addBulletList — add a bullet list (items can be strings or { text, level })
- addNumberedList — add a numbered list (items + optional format)

## Edit tools — sections
- setHeader — set document header (type: default/first/even)
- setFooter — set document footer (type: default/first/even)

## Edit tools — images
- insertImage — append an inline PNG/JPEG. Upload the bytes to CAS first and pass the 64-char hash. Optional widthPx and altText.
- deleteImage — remove an image by index
- replaceImage — replace an image's bytes with new CAS content (hash must be uploaded first)
- setImageSize — set display size in EMU (914400 EMU = 1 inch, 9525 EMU = 1 pixel at 96 DPI)
- setImageAltText — set the alt text (description) of an image

## Rules
- Indexes are zero-based.
- Always re-query after edits because document structure may change.
- Use getParagraphs to find paragraph and run indexes before editing.
- Use getTables to find table indexes before editing cells.
- When building tables, addTable first, then setCellText for each cell.
- insertImage and replaceImage do not upload bytes; the CAS node must already exist.
- For image sizes: 9525 EMU = 1 pixel at 96 DPI, so widthPx * 9525 = widthEmu.`;
