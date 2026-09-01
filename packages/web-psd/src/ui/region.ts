import type { Rect } from "../doc-model.js";

/**
 * The region axis of a selection target (spec §3.1): a patch of canvas the
 * user pointed at, which may or may not be a rectangle.
 *
 * A rectangle is the DEGENERATE case, not the basic one — when a person means
 * "this object" they draw a lasso or a smear. `maskId` is therefore present
 * from the first version even though only rectangles can be produced today:
 * widening `Rect` to `Region` later would touch crop, the context bar, the
 * composer, the overlay and seven test files all over again.
 *
 * The mask BYTES never live here. A full-canvas mask is a 12MB
 * Uint8ClampedArray, and this object goes into the global store, which
 * notifies every subscriber on every change (store.ts) and is snapshotted
 * whole by tests. The handle points into the module-level table in this same
 * file (added when its first producer lands — see doc-controller's
 * layerAlphaRegion).
 */
export interface Region {
  /** Enclosing rect, `[top,left,bottom,right]`, document pixels. Always set. */
  bounds: Rect;
  /** The gesture that produced it: decides how the UI describes it and
   *  whether it can be edited back. */
  source: "rect" | "lasso" | "wand" | "layerAlpha";
  /** Handle for per-pixel coverage; null for a plain rectangle. */
  maskId: string | null;
}

export function rectRegion(bounds: Rect): Region {
  return { bounds, source: "rect", maskId: null };
}

/**
 * Per-pixel coverage for regions that are not rectangles, keyed by the handle
 * their `Region` carries.
 *
 * Module scope, deliberately NOT part of `UiState`. The store notifies every
 * subscriber on every change and is snapshotted whole by tests; a full-canvas
 * mask is a 12MB Uint8ClampedArray, and putting it in there would mean
 * `resetState`, every test's hand-written INITIAL and any future state
 * serialization all having to route around it.
 *
 * Buffer layout: `bounds`-sized, one byte per pixel, 0..255, row-major.
 */
const maskBytes = new Map<string, Uint8ClampedArray>();
let nextMaskId = 1;

export function putMask(bytes: Uint8ClampedArray): string {
  const id = `m${nextMaskId++}`;
  maskBytes.set(id, bytes);
  return id;
}

export function getMask(id: string | null): Uint8ClampedArray | null {
  return id ? maskBytes.get(id) ?? null : null;
}

/** Exactly one region exists at a time, so exactly one mask is reachable.
 *  Called from `setRegion`, which is the only place a region is written. */
export function sweepMasks(keep: string | null): void {
  for (const id of [...maskBytes.keys()]) if (id !== keep) maskBytes.delete(id);
}

/**
 * The current target as one sentence, for the context bar.
 *
 * Every combination is meaningful (spec §3.2) — an empty axis is a default,
 * not a missing input. In particular "no layer + a region" is exactly what a
 * generative edit wants, so it must not read as an error.
 */
export function describeTarget(layerNames: string[], region: Region | null): string {
  // Three states, not four: the axes are mutually exclusive (spec §3.3), so
  // 「both set」 cannot occur. The layer axis is still checked first so that
  // if the invariant is ever broken the bar names something concrete rather
  // than silently claiming the whole document.
  if (layerNames.length > 0) return layerNames.join(" + ");
  return region ? "选区内的所有图层" : "整个文档";
}
