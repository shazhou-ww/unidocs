import type { PsdDoc, Layer } from "./model/types.js";
import { findLayer } from "./model/tree.js";
import { type BlobStore, PixelCache, resolvePixels, isRef } from "./render/pixel-source.js";

/** Faults a single layer's pixels to resident if it is a lazy PixelRef; a
 *  no-op for already-resident (or pixel-less) layers. Mutates `layer` in place
 *  — callers pass a layer inside an already-cloned doc. */
async function faultLayer(layer: Layer, store: BlobStore, cache: PixelCache): Promise<void> {
  if (layer.pixels && isRef(layer.pixels)) {
    layer.pixels = await resolvePixels(layer.pixels, store, cache);
  }
}

/** Faults every raster layer (recursively, groups included) in `layers`. */
async function faultAll(layers: Layer[], store: BlobStore, cache: PixelCache): Promise<void> {
  for (const l of layers) {
    await faultLayer(l, store, cache);
    if (l.children) await faultAll(l.children, store, cache);
  }
}

/** Resolve ONE layer's pixels (and its descendants, if it's a group) to
 *  resident, returning a NEW doc. Used by the pixel-mutating op path (flip) so
 *  the op sees resident pixels while sibling layers stay lazy — preserving the
 *  bounded-memory win. No-op if the target is already resident or not found. */
export async function resolveLayerPixels(doc: PsdDoc, layerId: string, store: BlobStore): Promise<PsdDoc> {
  const next = structuredClone(doc);
  const layer = findLayer(next.layers, layerId);
  if (!layer) return next;
  const cache = new PixelCache(Infinity);
  await faultLayer(layer, store, cache);
  if (layer.children) await faultAll(layer.children, store, cache);
  return next;
}

/** Resolve ALL layers' pixels to resident, returning a NEW doc. Used for full
 *  materialization (export/save), where every layer's bytes are needed anyway;
 *  the resolved doc is transient. Masks are already resident after deserialize
 *  and are left untouched. */
export async function resolveDoc(doc: PsdDoc, store: BlobStore): Promise<PsdDoc> {
  const next = structuredClone(doc);
  const cache = new PixelCache(Infinity);
  await faultAll(next.layers, store, cache);
  return next;
}
