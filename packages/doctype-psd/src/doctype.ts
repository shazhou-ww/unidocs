import type { DocumentTypeFactory } from "@unidocs/core";
import type { PsdDoc } from "./model/types.js";
import { apply, type PsdOp } from "./ops/index.js";
import { load } from "./psd/load.js";
import { save } from "./psd/save.js";
import { serialize, deserialize } from "./psd/ir.js";
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
  serialize,
  deserialize,
  apply,
  query: runQuery,
  contentType: "image/vnd.adobe.photoshop",
  tools,
  instructions,
});
