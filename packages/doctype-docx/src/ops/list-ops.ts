/**
 * List operations: addBulletList, addNumberedList.
 */

import type { Document } from "@ariadng/office/docx";
import type { DocxListItem } from "../types.js";

/** Add a bullet list with the given items. */
export function addBulletList(
  document: Document,
  items: DocxListItem[],
): void {
  if (items.length === 0) return;
  document.addBulletList(items);
}

/** Add a numbered list with the given items and optional format. */
export function addNumberedList(
  document: Document,
  items: DocxListItem[],
  format?: string,
): void {
  if (items.length === 0) return;
  const options = format
    ? { format: format as "decimal" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman" }
    : undefined;
  document.addNumberedList(items, options);
}
