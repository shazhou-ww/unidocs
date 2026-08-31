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

/**
 * Wheel deltas are not comparable across devices, so they are normalised to
 * CSS pixels before being turned into a zoom factor.
 *
 * `deltaMode` says what unit the browser used: pixels (0), lines (1) or pages
 * (2). Firefox reports lines on several platforms, where one notch is a
 * `deltaY` of about 3 — treating that as pixels makes the wheel do nothing at
 * all, the mirror image of treating a 120px notch as if it were fine-grained
 * trackpad movement.
 */
const LINE_PX = 16;
const PAGE_PX = 400;

export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * LINE_PX;
  if (deltaMode === 2) return deltaY * PAGE_PX;
  return deltaY;
}

/**
 * One mouse-wheel notch — 120 normalised px on most platforms — should be one
 * comfortable step, not a leap. At 1.2x per notch it takes about eight notches
 * to cross 100%→400%, which is brisk without being uncontrollable.
 *
 * The same rate serves a trackpad pinch, whose events are far smaller but far
 * more frequent: because the factor is exponential in the delta, accumulating
 * a frame's worth of small deltas gives the same result as one large one, so
 * the gesture stays proportional to finger movement without a device check.
 */
const NOTCH_PX = 120;
const NOTCH_FACTOR = 1.2;
export const WHEEL_ZOOM_RATE = Math.log(NOTCH_FACTOR) / NOTCH_PX;

/** Ceiling on how much ONE frame may zoom. Inertial scrolling and a
 *  fast-spinning wheel can pile up an arbitrarily large delta before the next
 *  frame; without a cap a single flick crosses the entire zoom range. */
export const WHEEL_MAX_DELTA = 2 * NOTCH_PX;

/** Normalised wheel delta → multiplicative zoom factor. Negative delta
 *  (scrolling up / pinching out) zooms in. */
export function wheelZoomFactor(delta: number): number {
  const capped = Math.max(-WHEEL_MAX_DELTA, Math.min(WHEEL_MAX_DELTA, delta));
  return Math.exp(-capped * WHEEL_ZOOM_RATE);
}
