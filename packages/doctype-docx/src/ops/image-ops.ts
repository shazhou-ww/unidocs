/**
 * Image operations: insertImage.
 */

import type { Document } from "@ariadng/office/docx";
import { validateHash } from "@unidocs/cas";
import type { DocumentTypeContext } from "@unidocs/core";

export interface InsertImagePayload {
  hash: string;
  widthPx?: number;
  altText?: string;
}

/** Embed a CAS-backed PNG/JPEG at the end of the document. */
export async function insertImage(
  document: Document,
  payload: InsertImagePayload,
  context?: DocumentTypeContext,
): Promise<void> {
  validateHash(payload.hash);
  if (!context?.cas) {
    throw new Error("insertImage requires CAS context");
  }
  const bytes = await context.cas.read({ kind: "cas", hash: payload.hash });
  document.addImage(bytes, {
    widthPx: payload.widthPx,
    altText: payload.altText,
  });
}
