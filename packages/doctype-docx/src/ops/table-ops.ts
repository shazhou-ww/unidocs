/**
 * Table operations: addTable, setCellText, addTableRow.
 */

import type { Document } from "@ariadng/office/docx";
import { requireIndex } from "../helpers.js";

/** Add a rows × cols table to the document. */
export function addTable(
  document: Document,
  rows: number,
  cols: number,
  style?: string,
): void {
  if (!Number.isSafeInteger(rows) || rows < 1) {
    throw new RangeError("rows must be a positive integer");
  }
  if (!Number.isSafeInteger(cols) || cols < 1) {
    throw new RangeError("cols must be a positive integer");
  }
  document.addTable(rows, cols, style ? { style } : undefined);
}

/** Set the text of a specific table cell. */
export function setCellText(
  document: Document,
  tableIndex: number,
  row: number,
  col: number,
  text: string,
): void {
  requireIndex(tableIndex, "tableIndex");
  requireIndex(row, "row");
  requireIndex(col, "col");

  const table = document.tables()[tableIndex];
  if (!table) throw new RangeError(`Table ${tableIndex} not found`);

  table.cell(row, col).setText(text);
}

/** Add a row to a table, copying cell properties from the last row. */
export function addTableRow(
  document: Document,
  tableIndex: number,
): void {
  requireIndex(tableIndex, "tableIndex");

  const table = document.tables()[tableIndex];
  if (!table) throw new RangeError(`Table ${tableIndex} not found`);

  table.addRow();
}
