/**
 * Shared utilities for the DOCX document type.
 */

import { Document } from "@ariadng/office/docx";
import type { SValue } from "@unidocs/protocol";

/** Validate that a value is a non-negative safe integer. */
export function requireIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

/** Build a query-friendly view of one paragraph. */
export function paragraphValue(doc: Document, index: number): SValue | null {
  requireIndex(index, "paragraph index");
  const paragraph = doc.paragraphs()[index];
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
