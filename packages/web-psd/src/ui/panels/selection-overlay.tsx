import { getController } from "../controller.js";
import { useUiState } from "../store.js";

/**
 * Marching-ants marquee, drawn as a DOM overlay above the canvas so the
 * compositor never has to re-render for a selection change.
 *
 * **Positioning contract for everything drawn over the canvas** (selection
 * chrome, handles, transform boxes, hover outlines — follow this):
 *
 * - Geometry is stored in DOCUMENT pixels and converted at render time with
 *   `controller.toScreen()`, which measures the canvas's laid-out box. That
 *   is what makes the overlay track the canvas at any zoom without this
 *   component knowing what the zoom is.
 * - The overlay is a SIBLING of the canvas inside `.stage-inner`, not a child
 *   of anything CSS-scaled. Zoom scales the canvas box; the overlay is
 *   re-positioned in CSS pixels instead of being scaled with it.
 * - Consequently CHROME DOES NOT SCALE: the 1.5px ants, the 6px handles stay
 *   crisp and grabbable at 25% and at 400% alike. Never express chrome
 *   thickness in document pixels, and never wrap this in a `transform:
 *   scale()` — both would make handles unusable at the extremes.
 */
export function SelectionOverlay() {
  const s = useUiState();
  const c = getController();
  if (!s.marquee || !c) return null;
  const [top, left, bottom, right] = s.marquee;
  const a = c.toScreen(left, top);
  const b = c.toScreen(right, bottom);
  return (
    <div className="marquee" style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }}>
      <i className="h tl" /><i className="h tr" /><i className="h bl" /><i className="h br" />
    </div>
  );
}
