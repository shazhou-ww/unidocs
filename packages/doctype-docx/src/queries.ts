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

    case "getParagraphFormat": {
      const paragraph = requireParagraph(doc, query.payload.paragraphIndex);
      const format = paragraph.format();
      return {
        alignment: format.alignment,
        indentLeftTwips: format.indentLeftTwips,
        indentRightTwips: format.indentRightTwips,
        indentFirstLineTwips: format.indentFirstLineTwips,
        spacingBeforeTwips: format.spacingBeforeTwips,
        spacingAfterTwips: format.spacingAfterTwips,
        lineSpacing: format.lineSpacing
          ? { value: format.lineSpacing.value, rule: format.lineSpacing.rule }
          : null,
        styleId: format.styleId,
        styleName: format.styleName,
      };
    }

    case "getRunFormat": {
      const paragraph = requireParagraph(doc, query.payload.paragraphIndex);
      requireIndex(query.payload.runIndex, "runIndex");
      const run = paragraph.runs()[query.payload.runIndex];
      if (!run) {
        throw new RangeError(
          `Run ${query.payload.runIndex} not found in paragraph ${query.payload.paragraphIndex}`,
        );
      }
      return { ...run.format() };
    }

    case "getParagraphList": {
      const paragraph = requireParagraph(doc, query.payload.paragraphIndex);
      const list = paragraph.list();
      return list ? { ...list } : null;
    }

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

    case "getImages":
      return doc.document.images().map((img, index) => ({
        index,
        format: img.format,
        partName: img.partName,
        widthEmu: img.widthEmu,
        heightEmu: img.heightEmu,
        altText: img.altText,
        placement: img.placement,
      }));

    case "getImage": {
      const { index } = query.payload;
      requireIndex(index, "image index");
      const images = doc.document.images();
      if (index < 0 || index >= images.length) {
        throw new RangeError(`Image index ${index} out of range (0-${images.length - 1})`);
      }
      const img = images[index];
      return {
        index,
        format: img.format,
        partName: img.partName,
        widthEmu: img.widthEmu,
        heightEmu: img.heightEmu,
        altText: img.altText,
        placement: img.placement,
      };
    }

    case "getImageByPartName": {
      const { partName } = query.payload;
      const images = doc.document.images();
      const index = images.findIndex((img) => img.partName === partName);
      if (index === -1) {
        return null;
      }
      const img = images[index];
      return {
        index,
        format: img.format,
        partName: img.partName,
        widthEmu: img.widthEmu,
        heightEmu: img.heightEmu,
        altText: img.altText,
        placement: img.placement,
      };
    }
  }
}

function requireParagraph(doc: DocxDoc, index: number) {
  requireIndex(index, "paragraphIndex");
  const paragraph = doc.document.paragraphs()[index];
  if (!paragraph) throw new RangeError(`Paragraph ${index} not found`);
  return paragraph;
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
