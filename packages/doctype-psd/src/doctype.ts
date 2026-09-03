import type { DocumentType, DocumentTypeContext, SValue } from "@unidocs/protocol";
import type { PsdDoc } from "./model/types.js";
import { type PsdOp } from "./ops/index.js";
import { save } from "./psd/save.js";
import { load } from "./psd/load.js";
import { casBlobStore } from "./psd/cas-blobstore.js";
import { docToPng, pngToDoc } from "./psd/png.js";
import { resolveDoc, resolveLayerPixels } from "./resolve.js";
import { DocRenderState } from "./render/doc-render-state.js";
import { runQuery, type PsdQuery } from "./queries.js";
import {
  materializePsdDoc,
  storePsdDoc,
  type PsdStoredDoc,
} from "./state.js";

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

  // Render state that lives as long as this factory — i.e. one Editor DO
  // instance, which is one document (`idFromName("${userId}:${docId}")`).
  //
  // Previously every `getPreview` built a fresh PixelCache and re-composited
  // the whole canvas, so an agent's edit→preview→edit loop paid a full decode
  // plus a full composite per step (~1s on a 3556x2000 file). Keeping one
  // warm cache and one incremental compositor here makes both incremental:
  // pixels are decoded once, and an op only invalidates the tiles its dirty
  // rect covers. Budgets are byte-bounded to fit a DO isolate — see
  // DocRenderState's memory note.
  const renderState = new DocRenderState(casBlobStore(ctx));

  /** The pre-op fault-in the free `apply()` performs: a flip mutates pixel
   *  bytes in place, so a lazy PixelRef must be resolved before it runs.
   *  Returns the doc unchanged for every other op. */
  const resolveForOp = async (doc: PsdDoc, op: PsdOp): Promise<PsdDoc> => {
    if (op.kind !== "transform") return doc;
    const payload = op.payload as { layerId?: string; op?: { flip?: unknown } };
    if (!payload?.op?.flip || !payload.layerId) return doc;
    return resolveLayerPixels(doc, payload.layerId, casBlobStore(ctx));
  };

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

    // Ops run THROUGH the resident compositor (not the free `apply`) so each
    // one invalidates only the tiles its dirty rect covers; the resulting doc
    // is identical either way (tests/doc-render-state.test.ts).
    apply: async (ops: readonly PsdOp[], state: PsdStoredDoc): Promise<PsdStoredDoc> =>
      store(await renderState.applyOps(ops, await materialize(state), resolveForOp)),

    query: async (q: PsdQuery, state: PsdStoredDoc): Promise<SValue> =>
      runQuery(q, await materialize(state), ctx, renderState) as Promise<SValue>,

    formats: {
      psd: {
        mediaTypes: ["image/vnd.adobe.photoshop"],
        extensions: [".psd"],
        load: async (data: Uint8Array): Promise<PsdStoredDoc> => store(await load(data)),
        save: async (state: PsdStoredDoc): Promise<Uint8Array> =>
          save(await resolveDoc(await materialize(state), casBlobStore(ctx))),
      },
      // PNG 是**入口格式**,不是另一种文档类型:load 进来之后文档仍然是 psd,
      // defaultFormat 也仍然是 psd,所以默认导出、目录里的 docType 都不变。
      png: {
        mediaTypes: ["image/png"],
        extensions: [".png"],
        load: async (data: Uint8Array): Promise<PsdStoredDoc> => store(pngToDoc(data)),
        // 与上面 psd 的 save 结构完全对称:先 materialize 再 resolveDoc 把
        // 懒加载的 CAS 像素拉实,然后才展平。少了 resolveDoc 就会渲染到
        // PixelRef 上。
        save: async (state: PsdStoredDoc): Promise<Uint8Array> =>
          docToPng(await resolveDoc(await materialize(state), casBlobStore(ctx))),
      },
    },
    defaultFormat: "psd",

    contentType: "image/vnd.adobe.photoshop",

  // PsdStoredLayer.children is recursive; this assertion only stops
  // SValueType from exceeding TypeScript's instantiation-depth limit.
  } as unknown as DocumentType<PsdStoredDoc, PsdQuery, PsdOp>;
}
