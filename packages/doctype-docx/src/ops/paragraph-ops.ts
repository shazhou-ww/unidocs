/**
 * Paragraph-level operations: appendParagraph, setRunText.
 */

import type { Document } from "@ariadng/office/docx";
import { requireIndex } from "../helpers.js";
import type { DocxParagraphOptions } from "../types.js";

/** Append a paragraph with optional style/formatting. */
export function appendParagraph(
  document: Document,
  text: string,
  options?: DocxParagraphOptions,
): void {
  document.addParagraph(text, options);
}

/** Replace the text of one run, preserving its formatting. */
export function setRunText(
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
