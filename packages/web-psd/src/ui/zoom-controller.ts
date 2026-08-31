import { flushSync } from "react-dom";
import { getController } from "./controller.js";
import { getState, setState } from "./store.js";
import { anchorScroll, clampZoom, fitZoom, initialZoom, nextStop } from "./zoom.js";

/**
 * The DOM half of zooming: hold a point still while the canvas resizes under
 * it, then fetch whatever tiles the new zoom exposed.
 *
 * Zoom itself is applied by React writing a CSS width/height onto the canvas
 * (see CanvasStage). This module exists for the part that cannot be
 * expressed declaratively: a zoom that does not hold some point still feels
 * like the document jumping away from you, and where that point ends up is
 * only knowable after the browser has re-laid-out the canvas.
 */

/** The stage's inner size, used for fit calculations. Zero before layout. */
function stageSize(): { width: number; height: number } {
  const stage = getController()?.stage;
  if (!stage) return { width: 0, height: 0 };
  return { width: stage.clientWidth, height: stage.clientHeight };
}

/**
 * Zooms to `target`, keeping the document point currently under `anchor`
 * (client coordinates) in the same place on screen. Without an anchor the
 * centre of the stage is held, which is what a zoom button should do.
 *
 * `flushSync` is load-bearing: the anchor's new position can only be measured
 * once React has written the new canvas size AND the browser has re-laid it
 * out. Letting the state update batch would measure the OLD layout and scroll
 * by a stale amount — the document would drift a little on every step, which
 * is worse than not compensating at all.
 */
export function zoomTo(target: number, anchor?: { clientX: number; clientY: number }): void {
  const zoom = clampZoom(target);
  const state = getState();
  if (zoom === state.zoom) return;

  const controller = getController();
  if (!controller) {
    setState({ zoom });
    return;
  }
  const stage = controller.stage;

  const rect = stage.getBoundingClientRect();
  const at = anchor ?? { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  // The document point to hold still, captured BEFORE the resize.
  const held = controller.toCanvas(at.clientX, at.clientY);

  flushSync(() => { setState({ zoom }); });

  // Where that point actually ended up, measured AFTER the re-layout.
  const canvasRect = controller.canvasRect();
  const now = controller.toScreen(held.x, held.y);
  stage.scrollLeft += anchorScroll(at.clientX, canvasRect.left + now.x);
  stage.scrollTop += anchorScroll(at.clientY, canvasRect.top + now.y);

  controller.setZoom();
}

/** One ladder step in `dir`, anchored on the stage centre. */
export function zoomStep(dir: 1 | -1): void {
  zoomTo(nextStop(getState().zoom, dir));
}

/** Continuous zoom by a multiplicative factor, anchored on the cursor. Used
 *  by ctrl/⌘+wheel and trackpad pinch, which must not snap to the ladder. */
export function zoomBy(factor: number, anchor: { clientX: number; clientY: number }): void {
  zoomTo(getState().zoom * factor, anchor);
}

/** Fit the document to the stage, in both directions. */
export function zoomFit(): void {
  const doc = getState().doc;
  if (!doc) return;
  zoomTo(fitZoom(doc.canvas, stageSize()));
}

export function zoomActual(): void {
  zoomTo(1);
}

/**
 * The zoom a freshly opened document should get: 1:1 unless it overflows.
 *
 * Applied without the anchor machinery — there is no point to hold still on a
 * document that was not on screen a moment ago, and `zoomTo` would be a no-op
 * anyway when the new zoom equals the old one.
 */
export function zoomForNewDoc(canvas: { width: number; height: number }): void {
  const zoom = initialZoom(canvas, stageSize());
  if (zoom !== getState().zoom) setState({ zoom });
  getController()?.setZoom();
}
