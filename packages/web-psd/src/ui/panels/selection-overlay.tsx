import { useUiState } from "../store.js";
import { rectStyle } from "../overlay-geometry.js";

/**
 * Marching-ants marquee, drawn as a DOM overlay above the canvas so the
 * compositor never has to re-render for a selection change.
 *
 * Positioned by `rectStyle` — the contract for everything drawn over the
 * canvas, and the reasoning behind it, live in `ui/overlay-geometry.ts`. Read
 * that before adding another overlay.
 */
export function SelectionOverlay() {
  const s = useUiState();
  const canvas = s.doc?.canvas;
  // Without the document's dimensions there is no fraction to express the
  // selection as. Unreachable in practice — a marquee is dragged onto a
  // document — but percentages have no meaningful fallback.
  if (!s.region || !canvas) return null;
  const [top, left, bottom, right] = s.region.bounds;
  return (
    <div className="marquee" style={rectStyle([top, left, bottom, right], canvas)}>
      <i className="h tl" /><i className="h tr" /><i className="h bl" /><i className="h br" />
    </div>
  );
}
