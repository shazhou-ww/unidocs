import type { DocumentTypeFactory } from "@unidocs/core";
import type { PsdDoc } from "./model/types.js";
import { apply, type PsdOp } from "./ops/index.js";
import { saveSnapshot, loadSnapshot, refsFromSnapshot } from "./psd/snapshot.js";
import { runQuery, type PsdQuery } from "./queries.js";
import { tools, instructions } from "./tools.js";

export type PsdOptions = Record<string, never>;
export type { PsdDoc, PsdQuery, PsdOp };

export const createPsdDocumentType: DocumentTypeFactory<PsdOptions, PsdDoc, PsdQuery, PsdOp> = (_options) => ({
  init: async (): Promise<PsdDoc> => ({
    canvas: { width: 0, height: 0, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [],
  }),
  load: loadSnapshot,
  save: saveSnapshot,
  apply,
  query: runQuery,
  // Snapshots are IR JSON referencing per-layer/mask pixel blobs in the CAS.
  refsFromSnapshot,
  refsFromOp: () => ({}),
  contentType: "image/vnd.adobe.photoshop",
  tools,
  instructions,
});
