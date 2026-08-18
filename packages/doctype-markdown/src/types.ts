/**
 * Markdown document type definitions.
 */

/** Markdown document in-memory model. */
export interface MDoc {
  /** Full markdown content as a string. */
  content: string;
}

/** Query types for markdown documents. */
export type MQuery =
  | { kind: "getContent"; payload: undefined }
  | { kind: "getSection"; payload: { heading: string } }
  | { kind: "getHeadings"; payload: undefined };

/** Operation types for markdown documents. */
export type MOp =
  | { kind: "setContent"; payload: { content: string } }
  | { kind: "appendSection"; payload: { heading: string; content: string } }
  | { kind: "replaceSection"; payload: { heading: string; content: string } }
  | { kind: "deleteSection"; payload: { heading: string } };
