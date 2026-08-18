/**
 * DOCX DocumentType implementation.
 *
 * Orchestrates operations from feature modules and wires up queries,
 * tools, and instructions.
 */

import { Document } from "@ariadng/office/docx";
import type { DocumentTypeFactory } from "@unidocs/core";
import { createState } from "./helpers.js";
import { appendParagraph, setRunText } from "./ops/paragraph-ops.js";
import { addTable, addTableRow, setCellText } from "./ops/table-ops.js";
import { addBulletList, addNumberedList } from "./ops/list-ops.js";
import { setFooter, setHeader } from "./ops/section-ops.js";
import { executeQuery } from "./queries.js";
import { instructions, tools } from "./tools.js";
import type { DocxDoc, DocxOperation, DocxQuery } from "./types.js";

export type DocxOptions = Record<string, never>;
export type DocxDocumentTypeFactory = DocumentTypeFactory<
  DocxOptions,
  DocxDoc,
  DocxQuery,
  DocxOperation
>;

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const createDocxDocumentType: DocxDocumentTypeFactory = (_options) => ({
  init: async () => createState(Document.create()),

  query: async (query, doc) => executeQuery(query, doc),

  apply: async (operations, doc) => {
    const working = await Document.open(doc.bytes);

    for (const operation of operations) {
      switch (operation.kind) {
        // Paragraph operations
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

        // Table operations
        case "addTable":
          addTable(working, operation.payload.rows, operation.payload.cols, operation.payload.style);
          break;
        case "setCellText":
          setCellText(
            working,
            operation.payload.tableIndex,
            operation.payload.row,
            operation.payload.col,
            operation.payload.text,
          );
          break;
        case "addTableRow":
          addTableRow(working, operation.payload.tableIndex);
          break;

        // List operations
        case "addBulletList":
          addBulletList(working, operation.payload.items);
          break;
        case "addNumberedList":
          addNumberedList(working, operation.payload.items, operation.payload.format);
          break;

        // Section operations
        case "setHeader":
          setHeader(working, operation.payload.text, operation.payload.type);
          break;
        case "setFooter":
          setFooter(working, operation.payload.text, operation.payload.type);
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

  tools,
  instructions,
});
