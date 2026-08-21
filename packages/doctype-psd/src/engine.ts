// Browser-safe engine surface: everything the in-browser renderer/editor
// needs, with NO ag-psd (parse/export) dependency. See design §1 packaging.
export {
  render, renderRegion, renderLayer, renderCached, downscale, DEFAULT_CACHE_BYTES,
} from "./render/index.js";
export type { RenderCtx } from "./render/index.js";
export { apply, applyOne } from "./ops/index.js";
export type { PsdOp } from "./ops/index.js";
export { resolveDoc, resolveLayerPixels } from "./resolve.js";
export { deserialize } from "./psd/ir.js";
export {
  PixelCache, resolvePixels, isRef,
} from "./render/pixel-source.js";
export type { PixelSource, PixelRef, BlobStore } from "./render/pixel-source.js";
export type {
  Layer, Mask, Pixels, Canvas, PsdDoc, BlendMode, LayerType,
} from "./model/types.js";
