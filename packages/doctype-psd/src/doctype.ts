import type { DocumentType, DocumentTypeContext, SValue } from "@unidocs/core";
import type { PsdDoc } from "./model/types.js";
import { apply, type PsdOp } from "./ops/index.js";
import { saveSnapshot, loadSnapshot, refsFromSnapshot } from "./psd/snapshot.js";
import { casBlobStore } from "./psd/cas-blobstore.js";
import { resolveDoc } from "./resolve.js";
import { runQuery, type PsdQuery } from "./queries.js";
import { tools, instructions } from "./tools.js";

export type { PsdDoc, PsdQuery, PsdOp };

/**
 * PSD DocumentType factory.
 *
 * PSD documents contain binary pixel data (Uint8Array) that is not directly
 * SValue-encodable, so this factory uses a type assertion to bridge the gap
 * between the SValue-constrained DocumentType interface and PSD's binary model.
 * The runtime layer (server-core session) already handles this with its own
 * casts.
 */
export function createPsdDocumentType(ctx: DocumentTypeContext): DocumentType<PsdDoc, PsdQuery, PsdOp> {
  return {
    init: async (): Promise<PsdDoc> => ({
      canvas: { width: 0, height: 0, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
      layers: [],
    }),

    resolve: (doc: PsdDoc) => resolveDoc(doc, casBlobStore(ctx)),

    apply: async (ops: readonly PsdOp[], doc: PsdDoc): Promise<PsdDoc> =>
      apply(ops, doc, ctx),

    query: async (q: PsdQuery, doc: PsdDoc): Promise<SValue> =>
      runQuery(q, doc, ctx) as Promise<SValue>,

    formats: {
      psd: {
        mediaTypes: ["image/vnd.adobe.photoshop"],
        extensions: [".psd"],
        load: async (data: Uint8Array): Promise<PsdDoc> => loadSnapshot(data, ctx),
        save: async (doc: PsdDoc): Promise<Uint8Array> => saveSnapshot(doc, ctx),
      },
    },
    defaultFormat: "psd",

    contentType: "image/vnd.adobe.photoshop",

    refsFromSnapshot,
    refsFromOp: () => ({}),

    tools,
    instructions,
  } as unknown as DocumentType<PsdDoc, PsdQuery, PsdOp>;
}
