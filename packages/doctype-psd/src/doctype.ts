import type { DocumentType, DocumentTypeContext, SValue } from "@unidocs/protocol";
import type { PsdDoc } from "./model/types.js";
import { apply, type PsdOp } from "./ops/index.js";
import { save } from "./psd/save.js";
import { load } from "./psd/load.js";
import { casBlobStore } from "./psd/cas-blobstore.js";
import { resolveDoc } from "./resolve.js";
import { runQuery, type PsdQuery } from "./queries.js";
import {
  materializePsdDoc,
  storePsdDoc,
  type PsdStoredDoc,
} from "./state.js";
import { tools, instructions } from "./tools.js";

export type { PsdDoc, PsdStoredDoc, PsdQuery, PsdOp };

/**
 * PSD DocumentType factory.
 *
 * PsdStoredDoc is the persistent SValue TDoc. The binary PsdDoc editing model
 * is materialized on demand and cached only for the lifetime of this factory.
 */
export function createPsdDocumentType(
  ctx: DocumentTypeContext,
): DocumentType<PsdStoredDoc, PsdQuery, PsdOp> {
  const modelCache = new WeakMap<PsdStoredDoc, PsdDoc>();

  async function materialize(state: PsdStoredDoc): Promise<PsdDoc> {
    const cached = modelCache.get(state);
    if (cached) return cached;
    const model = await materializePsdDoc(state, ctx);
    modelCache.set(state, model);
    return model;
  }

  async function store(model: PsdDoc): Promise<PsdStoredDoc> {
    const state = await storePsdDoc(model, ctx);
    modelCache.set(state, model);
    return state;
  }

  return {
    init: async (): Promise<PsdStoredDoc> => store({
      canvas: { width: 0, height: 0, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
      layers: [],
    }),

    apply: async (ops: readonly PsdOp[], state: PsdStoredDoc): Promise<PsdStoredDoc> =>
      store(await apply(ops, await materialize(state), ctx)),

    query: async (q: PsdQuery, state: PsdStoredDoc): Promise<SValue> =>
      runQuery(q, await materialize(state), ctx) as Promise<SValue>,

    formats: {
      psd: {
        mediaTypes: ["image/vnd.adobe.photoshop"],
        extensions: [".psd"],
        load: async (data: Uint8Array): Promise<PsdStoredDoc> => store(await load(data)),
        save: async (state: PsdStoredDoc): Promise<Uint8Array> =>
          save(await resolveDoc(await materialize(state), casBlobStore(ctx))),
      },
    },
    defaultFormat: "psd",

    contentType: "image/vnd.adobe.photoshop",

    tools,
    instructions,
  // PsdStoredLayer.children is recursive; this assertion only stops
  // SValueType from exceeding TypeScript's instantiation-depth limit.
  } as unknown as DocumentType<PsdStoredDoc, PsdQuery, PsdOp>;
}
