import { getController } from "../controller.js";
import { useUiState } from "../store.js";

/** Marching-ants marquee, drawn as a DOM overlay above the canvas so the
 *  compositor never has to re-render for a selection change. */
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
