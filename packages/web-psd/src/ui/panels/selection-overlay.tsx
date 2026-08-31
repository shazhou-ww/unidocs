import { useUiState } from "../store.js";

/**
 * Marching-ants marquee, drawn as a DOM overlay above the canvas so the
 * compositor never has to re-render for a selection change.
 *
 * **Positioning contract for everything drawn over the canvas** (selection
 * chrome, handles, transform boxes, hover outlines — follow this):
 *
 * - Geometry is stored in DOCUMENT pixels and emitted as a PERCENTAGE of the
 *   containing block. `.marquee` is absolutely positioned, so its containing
 *   block is `.stage-inner` — which has no padding and shrink-wraps the
 *   canvas, making its padding box exactly the canvas box. `left: 25%` is
 *   therefore 25% across the document, whatever size the canvas is drawn at.
 * - The overlay is a SIBLING of the canvas inside `.stage-inner`, not a child
 *   of anything CSS-scaled. Zoom scales the canvas box; the overlay resolves
 *   its own percentages against that box instead of being scaled with it.
 * - Consequently CHROME DOES NOT SCALE: the 1.5px ants, the 6px handles stay
 *   crisp and grabbable at 25% and at 400% alike. Never express chrome
 *   thickness in document pixels, and never wrap this in a `transform:
 *   scale()` — both would make handles unusable at the extremes.
 *
 * **Why percentages rather than measuring `toScreen()` at render time.**
 * Measuring during render reads the DOM before React has committed the new
 * canvas size, so a zoom would position the overlay against the PREVIOUS
 * box and leave it there until some unrelated state change re-rendered it.
 * Percentages hand the arithmetic to the browser, which resolves them during
 * layout — after the new size is in effect, by construction. It also covers
 * every other cause of the box changing (a future fit-on-resize mode, a CSS
 * transition on the canvas) with no observer, no extra render, and no
 * notification plumbing to forget. `toScreen()` remains the right tool for
 * anything measured OUTSIDE render, e.g. in an event handler, where layout
 * has already settled.
 */
export function SelectionOverlay() {
  const s = useUiState();
  const canvas = s.doc?.canvas;
  // Without the document's dimensions there is no fraction to express the
  // selection as. Unreachable in practice — a marquee is dragged onto a
  // document — but percentages have no meaningful fallback.
  if (!s.marquee || !canvas) return null;
  const [top, left, bottom, right] = s.marquee;
  return (
    <div className="marquee" style={rectStyle([top, left, bottom, right], canvas)}>
      <i className="h tl" /><i className="h tr" /><i className="h bl" /><i className="h br" />
    </div>
  );
}

/**
 * A document-space rect as percentages of the document's own size — which is
 * what the containing block measures, so the browser resolves these against
 * whatever the canvas is currently drawn at.
 *
 * Exported for the same reason it is a separate function: anything else drawn
 * over the canvas (handles, transform boxes, hover outlines) must position
 * itself the same way, and sharing this is how that stays true.
 */
export function rectStyle(
  rect: [number, number, number, number],
  canvas: { width: number; height: number },
): { left: string; top: string; width: string; height: string } {
  const [top, left, bottom, right] = rect;
  const pct = (v: number, total: number): string => `${total > 0 ? (v / total) * 100 : 0}%`;
  return {
    left: pct(left, canvas.width),
    top: pct(top, canvas.height),
    width: pct(right - left, canvas.width),
    height: pct(bottom - top, canvas.height),
  };
}
