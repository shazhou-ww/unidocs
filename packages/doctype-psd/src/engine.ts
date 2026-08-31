// Browser-safe engine surface: everything the in-browser renderer/editor
// needs, with NO ag-psd (parse/export) dependency. See design §1 packaging.
export {
  render, renderRegion, renderLayer, renderCached, downscale, DEFAULT_CACHE_BYTES,
} from "./render/index.js";
export type { RenderCtx } from "./render/index.js";
export { apply, applyOne } from "./ops/index.js";
export type { PsdOp } from "./ops/index.js";
export { renderRegionDirect, layerInfluenceBounds } from "./render/region.js";
export { foldRange } from "./render/composite.js";
export type { Target } from "./render/composite.js";
export { resolveDoc, resolveLayerPixels } from "./resolve.js";
export { deserialize } from "./psd/ir.js";
export { materializePsdDocFromStore } from "./state.js";
export type { PsdStoredDoc } from "./state.js";
export {
  PixelCache, resolvePixels, isRef,
} from "./render/pixel-source.js";
export type { PixelSource, PixelRef, BlobStore } from "./render/pixel-source.js";
export type {
  Layer, Mask, Pixels, Canvas, PsdDoc, BlendMode, LayerType,
} from "./model/types.js";
export { IncrementalCompositor } from "./render/incremental.js";
export { allTiles, tilesForRect, tileKey } from "./render/tile-grid.js";
export type { Tile } from "./render/tile-grid.js";
export { opDirtyRect, opActiveIndex } from "./render/dirty-rect.js";

// Point-sampling helpers the browser hit test needs. Exported rather than
// re-implemented in psd-client: a second copy of the mask rules (defaultColor
// outside the rect, `inverted`) would drift from the compositor's, and then
// clicking would disagree with what is on screen.
export { maskCoverageAt } from "./render/composite.js";
export { findLayer } from "./model/tree.js";
