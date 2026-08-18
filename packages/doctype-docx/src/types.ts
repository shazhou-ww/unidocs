import type { Document } from "@ariadng/office/docx";

/** DOCX document state with canonical serialized bytes. */
export interface DocxDoc {
  readonly bytes: Uint8Array;
  readonly document: Document;
}

// ─── Shared option types ────────────────────────────────────────────

export interface DocxParagraphOptions {
  style?: string;
  bold?: boolean;
  italic?: boolean;
}

/** One list item: plain string = level-0, object = nested. */
export type DocxListItem = string | { text: string; level: number };

/** Which pages a header/footer applies to. */
export type DocxHeaderFooterType = "default" | "first" | "even";

// ─── Query types ────────────────────────────────────────────────────

export type DocxQuery =
  | { kind: "getText"; payload: undefined }
  | { kind: "getParagraphs"; payload: undefined }
  | { kind: "getParagraph"; payload: { index: number } }
  | { kind: "getTables"; payload: undefined }
  | { kind: "getTable"; payload: { index: number } }
  | { kind: "getHeaders"; payload: undefined }
  | { kind: "getFooters"; payload: undefined };

// ─── Operation types ────────────────────────────────────────────────

export type DocxOperation =
  // Paragraph operations
  | {
      kind: "appendParagraph";
      payload: { text: string; options?: DocxParagraphOptions };
    }
  | {
      kind: "setRunText";
      payload: { paragraphIndex: number; runIndex: number; text: string };
    }
  // Table operations
  | {
      kind: "addTable";
      payload: { rows: number; cols: number; style?: string };
    }
  | {
      kind: "setCellText";
      payload: { tableIndex: number; row: number; col: number; text: string };
    }
  | {
      kind: "addTableRow";
      payload: { tableIndex: number };
    }
  // List operations
  | {
      kind: "addBulletList";
      payload: { items: DocxListItem[] };
    }
  | {
      kind: "addNumberedList";
      payload: { items: DocxListItem[]; format?: string };
    }
  // Section operations
  | {
      kind: "setHeader";
      payload: { text: string; type?: DocxHeaderFooterType };
    }
  | {
      kind: "setFooter";
      payload: { text: string; type?: DocxHeaderFooterType };
    };
