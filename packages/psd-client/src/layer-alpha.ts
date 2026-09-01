import type { Layer, Pixels } from "@unidocs/doctype-psd/engine";
import { maskCoverageAt } from "@unidocs/doctype-psd/engine";

export type Rect = [number, number, number, number];

/** Below this, a pixel does not count as hit. Not zero: the near-transparent
 *  outer edge of a glow covers a large area and selecting by it feels random. */
export const HIT_ALPHA_THRESHOLD = 8 / 255;

/** How deep the candidate stack under the cursor goes. Alt-cycling and the
 *  right-click list read it; past a handful it stops being a menu anyone can
 *  use, and a full-canvas background means the walk would otherwise never stop
 *  early. */
export const MAX_CANDIDATES = 8;

export interface HitCandidate {
  layerId: string;
  path: string[];
}

/** How the caller supplies already-decoded pixels. Everything in this module
 *  is synchronous; faulting lazy PixelRefs in is the caller's job (see
 *  RenderCore), which is what makes the rules here testable with no store. */
export type ResidentPixels = (layer: Layer) => Pixels | null;

/** For callers whose layers are already resident (tests, and any doc that was
 *  never lazy). */
export function residentOnly(layer: Layer): Pixels | null {
  const p = layer.pixels;
  return p && "data" in p ? (p as Pixels) : null;
}

/**
 * The rect a layer occupies. A PSD group is a section divider whose own
 * bounds are usually `0,0,0,0` — it is a render scope, not a spatial
 * container — so a group's extent has to come from its visible children.
 */
export function layerBoxOf(layer: Layer): Rect | null {
  if (!layer.children) return [...layer.bounds] as Rect;
  let box: Rect | null = null;
  for (const child of layer.children) {
    if (!child.visible) continue;
    const b = layerBoxOf(child);
    if (!b) continue;
    box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
  }
  return box;
}

/**
 * Coverage of one layer at one canvas pixel, 0..1.
 *
 * `shapeOnly` gives the CLIP BASE reading: a clipping mask is confined by the
 * base's transparency and mask but not by its opacity, matching
 * `composite.ts`'s `layerAlpha`. The hit reading (`shapeOnly === false`)
 * multiplies opacity and fillOpacity, because that is what the user can
 * actually see.
 */
export function alphaAt(layer: Layer, x: number, y: number, resident: ResidentPixels, shapeOnly: boolean): number {
  // An adjustment layer transforms the whole backdrop; there is no shape to
  // point at, and picking one by clicking would be an accident every time.
  if (layer.type === "adjustment") return 0;

  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let a = 0;

  if (layer.children) {
    for (const child of layer.children) {
      if (!child.visible) continue;
      a = Math.max(a, alphaAt(child, x, y, resident, false));
      if (a >= 1) break;
    }
  } else {
    const [top, left, bottom, right] = layer.bounds;
    if (cx < left || cx >= right || cy < top || cy >= bottom) return 0;
    const px = resident(layer);
    if (!px) return 0;
    const ix = cx - left;
    const iy = cy - top;
    if (ix < 0 || iy < 0 || ix >= px.width || iy >= px.height) return 0;
    a = px.data[(iy * px.width + ix) * 4 + 3] / 255;
  }

  if (a <= 0) return 0;
  if (layer.mask) a *= maskCoverageAt(layer.mask, cx, cy);
  if (shapeOnly) return a;
  return a * layer.opacity * (layer.fillOpacity ?? 1);
}

function maxAlpha(layer: Layer, points: Array<[number, number]>, resident: ResidentPixels, shapeOnly: boolean): number {
  let best = 0;
  for (const [x, y] of points) {
    best = Math.max(best, alphaAt(layer, x, y, resident, shapeOnly));
    if (best >= 1) break;
  }
  return best;
}

/**
 * The layer whose shape confines `layers[i]`, or null when the compositor
 * renders it UNCONFINED — which is not the same as invisible.
 *
 * Mirrors `renderList`'s clip-base state machine (composite.ts): a hidden
 * non-clipping layer resets the base, an adjustment layer never becomes one,
 * and a run of consecutive clipping layers shares the base below the run.
 */
function clipBaseFor(layers: Layer[], i: number): Layer | null {
  let base: Layer | null = null;
  for (let j = 0; j < i; j++) {
    const l = layers[j];
    if (!l.visible) { if (!l.clipping) base = null; continue; }
    if (l.clipping && base) continue;            // confined; the base persists
    base = l.type !== "adjustment" ? l : null;
  }
  return base;
}

/**
 * Every layer under `points`, topmost first.
 *
 * A stack rather than a single answer because one click landing on several
 * plausible layers is NORMAL in a PSD, not an edge case (spec §3.4): the
 * layers are a paint-order stack with arbitrary overlap, a background covers
 * the whole canvas, and one visual object is often four layers. Alt-cycling
 * and the right-click list are how the user disambiguates, and both read this
 * list — which the walk produces anyway.
 *
 * `points` carries the click tolerance: the caller passes the cursor plus a
 * few neighbours, and the most opaque sample wins. That has to be computed in
 * DOCUMENT pixels from a CSS-pixel constant, because at the 5% zoom floor
 * three CSS pixels are sixty document pixels.
 */
export function hitInList(
  layers: Layer[],
  points: Array<[number, number]>,
  threshold: number,
  resident: ResidentPixels,
  path: string[] = [],
  out: HitCandidate[] = [],
): HitCandidate[] {
  for (let i = layers.length - 1; i >= 0 && out.length < MAX_CANDIDATES; i--) {
    const layer = layers[i];
    if (!layer.visible || layer.type === "adjustment") continue;

    // A clipping layer paints only where the base below it does, but its own
    // alpha stays non-zero in the clipped-away part — judging it alone would
    // select it where nothing of it is visible.
    let confine = 1;
    if (layer.clipping) {
      const base = clipBaseFor(layers, i);
      // No base means the compositor takes renderList's else branch and paints
      // this layer unconfined — so leave `confine` at 1 rather than reading
      // "nothing to clip to" as "nothing is visible".
      if (base) {
        confine = maxAlpha(base, points, resident, true);
        if (confine <= 0) continue;
      }
    }

    if (maxAlpha(layer, points, resident, false) * confine < threshold) continue;

    // A group's coverage is its children's, so the group passing means at
    // least one child does. Descend rather than reporting the group: `path`
    // is what lets the caller choose a level (spec §8's click semantics).
    if (layer.children) hitInList(layer.children, points, threshold, resident, [...path, layer.id], out);
    else out.push({ layerId: layer.id, path: [...path, layer.id] });
  }
  return out;
}
