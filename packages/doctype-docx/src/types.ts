import type { Document } from "@ariadng/office/docx";

/** DOCX document state with canonical serialized bytes. */
export interface DocxDoc {
  readonly bytes: Uint8Array;
  readonly document: Document;
}

export interface DocxParagraphOptions {
  style?: string;
  bold?: boolean;
  italic?: boolean;
}

/** Query types supported by the initial DOCX document type. */
export type DocxQuery =
  | { kind: "getText"; payload: undefined }
  | { kind: "getParagraphs"; payload: undefined }
  | { kind: "getParagraph"; payload: { index: number } };

/** Operations supported by the initial DOCX document type. */
export type DocxOperation =
  | {
      kind: "appendParagraph";
      payload: { text: string; options?: DocxParagraphOptions };
    }
  | {
      kind: "setRunText";
      payload: { paragraphIndex: number; runIndex: number; text: string };
    };
