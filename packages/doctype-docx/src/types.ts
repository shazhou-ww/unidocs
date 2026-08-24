import type { SBlob } from "@unidocs/protocol";

/** Immutable OpenXML package manifest. */
export interface DocxDoc {
  readonly kind: "openxml-package";
  readonly files: Readonly<Record<string, SBlob>>;
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
  | { kind: "getText" }
  | { kind: "getParagraphs" }
  | { kind: "getParagraph"; payload: { index: number } }
  | { kind: "getParagraphFormat"; payload: { paragraphIndex: number } }
  | { kind: "getRunFormat"; payload: { paragraphIndex: number; runIndex: number } }
  | { kind: "getParagraphList"; payload: { paragraphIndex: number } }
  | { kind: "getTables" }
  | { kind: "getTable"; payload: { index: number } }
  | { kind: "getHeaders" }
  | { kind: "getFooters" }
  | { kind: "getImages" }
  | { kind: "getImage"; payload: { index: number } }
  | { kind: "getImageContent"; payload: { index: number } }
  | { kind: "getImageByPartName"; payload: { partName: string } };

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
    payload: { rows: number; cols: number; style?: string; widthsTwips?: number[] };
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
  }
  // Image operations
  | {
    kind: "insertImage";
    payload: { blob: SBlob; widthPx?: number; altText?: string };
  }
  | {
    kind: "deleteImage";
    payload: { index: number };
  }
  | {
    kind: "replaceImage";
    payload: { index: number; blob: SBlob };
  }
  | {
    kind: "setImageSize";
    payload: { index: number; widthEmu?: number; heightEmu?: number };
  }
  | {
    kind: "setImageAltText";
    payload: { index: number; altText: string };
  };
