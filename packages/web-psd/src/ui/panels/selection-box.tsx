import { selectedLayers, useUiState } from "../store.js";
import { findLayer, layerBox, unionRect } from "../hit-test.js";
import { rectStyle } from "../overlay-geometry.js";
import { useHoverId } from "../overlay-store.js";
import type { Rect } from "../../doc-model.js";

/**
 * The layer axis drawn over the canvas: one outline per selected layer, a
 * union box carrying the handles, and a fainter outline for whatever the
 * cursor is over.
 *
 * Positioning follows `ui/overlay-geometry.ts` — percentages of the document,
 * never a measurement taken during render.
 *
 * The eight handles are VISUAL ONLY this phase. Dragging one would really
 * scale the layer, which needs the affine resampler in composite.ts that does
 * not exist yet — so there is deliberately no `cursor: nwse-resize` and
 * nothing else that suggests they can be grabbed.
 */
export function SelectionBox() {
  const s = useUiState();
  const hoverId = useHoverId();
  const canvas = s.doc?.canvas;
  // No document is the FIRST screen, not an edge case (controller.ts opens
  // nothing on startup), and a percentage has nothing to be a fraction of.
  if (!canvas) return null;

  const boxes = selectedLayers(s)
    .map((l) => layerBox(l))
    .filter((b): b is Rect => !!b);
  const union = boxes.reduce<Rect | null>((acc, b) => (acc ? unionRect(acc, b) : b), null);

  const hovered = hoverId && !s.selection.includes(hoverId) ? findLayer(s.doc!.layers, hoverId) : null;
  const hoverRect = hovered ? layerBox(hovered) : null;

  return (
    <>
      {hoverRect ? <div className="sel-hover" style={rectStyle(hoverRect, canvas)} /> : null}
      {/* With one layer selected the union box IS that layer's box, so the
          per-layer outlines would just double the same line. */}
      {boxes.length > 1
        ? boxes.map((b, i) => <div key={i} className="sel-box" style={rectStyle(b, canvas)} />)
        : null}
      {union ? (
        <div className="sel-union" style={rectStyle(union, canvas)}>
          <i className="h tl" /><i className="h tc" /><i className="h tr" />
          <i className="h ml" /><i className="h mr" />
          <i className="h bl" /><i className="h bc" /><i className="h br" />
        </div>
      ) : null}
    </>
  );
}
