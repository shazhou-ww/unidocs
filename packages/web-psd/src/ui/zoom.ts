import type { Size } from "@unidocs/psd-client";

/**
 * Zoom arithmetic. Everything here is pure so the interesting decisions —
 * which stop a step lands on, what "fit" means, how far to scroll to hold an
 * anchor still — are testable without a DOM.
 *
 * The zoom VALUE lives in the UI store and reaches the canvas as a CSS box
 * size. Nothing here knows that; nothing downstream is told the zoom either,
 * since `Viewport` measures it back off the laid-out element.
 */

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;

/**
 * Geometric rather than linear: a fixed ±25% step is unusable at the bottom
 * (25%→50% doubles) and pointless at the top (375%→400% is under 7%). These
 * are the familiar image-editor stops, each roughly a third to a half apart.
 */
export const ZOOM_STOPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4] as const;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * The next stop above (`dir` 1) or below (`dir` -1) `z`.
 *
 * `z` is not necessarily ON a stop — the wheel zooms continuously and "fit"
 * lands wherever the document requires — so this steps to the next stop
 * strictly past it rather than indexing. A small epsilon keeps a value that
 * is a stop (within float noise) from counting as "strictly past" itself.
 */
export function nextStop(z: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir === 1) return ZOOM_STOPS.find((s) => s > z + eps) ?? ZOOM_MAX;
  return [...ZOOM_STOPS].reverse().find((s) => s < z - eps) ?? ZOOM_MIN;
}

/**
 * The zoom at which `doc` exactly fits inside `stage`, minus a margin so the
 * document does not touch the panel edges.
 *
 * Fits in BOTH directions: an explicit "fit to window" on a small document
 * scales it up, which is what the command means everywhere else. Cold start
 * uses `initialZoom` below instead, which deliberately does not.
 */
export function fitZoom(doc: Size, stage: Size, margin = 32): number {
  if (doc.width <= 0 || doc.height <= 0) return 1;
  // An unmeasured stage (not yet laid out, or a detached test render) is not
  // a very small stage. Fitting to it would compute a ratio against ~zero and
  // clamp to the floor, so opening a large document before layout settles
  // would land at 5% instead of a sensible zoom. Refuse to guess.
  if (stage.width <= margin || stage.height <= margin) return 1;
  const w = stage.width - margin;
  const h = stage.height - margin;
  return clampZoom(Math.min(w / doc.width, h / doc.height));
}

/** Cold-start zoom: 1:1 unless the document overflows the stage, in which
 *  case it is shrunk to fit. Never enlarges — opening a small asset at 300%
 *  because it happens to be small is disorienting. */
export function initialZoom(doc: Size, stage: Size, margin = 32): number {
  return Math.min(1, fitZoom(doc, stage, margin));
}

/**
 * How far to scroll so the document point that was under `anchorClient`
 * before the zoom is under it again after.
 *
 * Deliberately expressed in terms of where the anchor point ACTUALLY landed
 * (`anchorNowClient`, measured after the browser has re-laid-out the canvas)
 * rather than derived from the old and new zoom factors. The stage centres
 * its content with `margin:auto`, so the canvas's offset inside the scroll
 * area shifts on its own as the box grows or shrinks — modelling that would
 * mean reimplementing flexbox. Measuring the result instead is correct
 * whatever the layout does.
 */
export function anchorScroll(anchorClient: number, anchorNowClient: number): number {
  return anchorNowClient - anchorClient;
}
