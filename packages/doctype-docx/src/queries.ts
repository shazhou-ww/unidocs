/**
 * All query implementations for the DOCX document type.
 */

import type { QueryValue } from "@unidocs/core";
import { paragraphValue, requireIndex } from "./helpers.js";
import type { DocxDoc, DocxQuery } from "./types.js";

/** Execute a query against a DOCX document. */
export function executeQuery(query: DocxQuery, doc: DocxDoc): QueryValue {
  switch (query.kind) {
    case "getText":
      return doc.document.text();

    case "getParagraphs":
      return doc.document
        .paragraphs()
        .map((_, index) => paragraphValue(doc, index)!);

    case "getParagraph":
      return paragraphValue(doc, query.payload.index);

    case "getTables":
      return doc.document.tables().map((table, index) => tableSummary(table, index));

    case "getTable": {
      const index = query.payload.index;
      requireIndex(index, "table index");
      const table = doc.document.tables()[index];
      if (!table) return null;
      return tableDetail(table, index);
    }

    case "getHeaders":
      return doc.document.headers().map((h) => ({
        kind: h.kind,
        type: h.type,
        partName: h.partName,
        text: h.text(),
      }));

    case "getFooters":
      return doc.document.footers().map((f) => ({
        kind: f.kind,
        type: f.type,
        partName: f.partName,
        text: f.text(),
      }));
  }
}

/** Summary view of a table (for getTables). */
function tableSummary(table: { rowCount(): number; columnCount(): number; styleId(): string | undefined; depth: number }, index: number): QueryValue {
  return {
    index,
    depth: table.depth,
    rowCount: table.rowCount(),
    columnCount: table.columnCount(),
    styleId: table.styleId() ?? null,
  };
}

/** Detailed view of a table (for getTable). */
function tableDetail(table: { rowCount(): number; columnCount(): number; styleId(): string | undefined; depth: number; rows(): readonly { cells(): readonly { text(): string }[] }[] }, index: number): QueryValue {
  return {
    index,
    depth: table.depth,
    rowCount: table.rowCount(),
    columnCount: table.columnCount(),
    styleId: table.styleId() ?? null,
    rows: table.rows().map((row, rowIndex) => ({
      index: rowIndex,
      cells: row.cells().map((cell, cellIndex) => ({
        index: cellIndex,
        text: cell.text(),
      })),
    })),
  };
}
