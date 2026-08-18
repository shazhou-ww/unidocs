/**
 * Section operations: setHeader, setFooter.
 */

import type { Document } from "@ariadng/office/docx";
import type { DocxHeaderFooterType } from "../types.js";

/** Set a document header. */
export function setHeader(
  document: Document,
  text: string,
  type?: DocxHeaderFooterType,
): void {
  document.setHeader(text, type ? { type } : undefined);
}

/** Set a document footer. */
export function setFooter(
  document: Document,
  text: string,
  type?: DocxHeaderFooterType,
): void {
  document.setFooter(text, type ? { type } : undefined);
}
