import type { DocumentTypeFactory } from "@unidocs/core";
import type { PsdDoc } from "./model/types.js";
import { apply, type PsdOp } from "./ops/index.js";
import { load } from "./psd/load.js";
import { save } from "./psd/save.js";
import { runQuery, type PsdQuery } from "./queries.js";
import { tools, instructions } from "./tools.js";

export type PsdOptions = Record<string, never>;
export type { PsdDoc, PsdQuery, PsdOp };

export const createPsdDocumentType: DocumentTypeFactory<PsdOptions, PsdDoc, PsdQuery, PsdOp> = (_options) => ({
  init: async (): Promise<PsdDoc> => ({
    canvas: { width: 0, height: 0, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [],
  }),
  load,
  save,
  apply,
  query: runQuery,
  // PSD does not use CAS refs yet — that arrives in a later stage.
  refsFromSnapshot: () => ({}),
  refsFromOp: () => ({}),
  contentType: "image/vnd.adobe.photoshop",
  tools,
  instructions,
});
