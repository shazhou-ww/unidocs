/**
 * Shared utilities for the DOCX document type.
 */

import { Document } from "@ariadng/office/docx";
import type { DocxDoc, DocxParagraphOptions } from "./types.js";
import type { QueryValue } from "@unidocs/core";

/** Validate that a value is a non-negative safe integer. */
export function requireIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

/** Build a query-friendly view of one paragraph. */
export function paragraphValue(doc: DocxDoc, index: number): QueryValue | null {
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

/** Save a Document into a DocxDoc state. */
export async function createState(document: Document): Promise<DocxDoc> {
  return { bytes: await document.save(), document };
}
