import { useEffect, useRef } from "react";
import { dispatch, getController, initController } from "../controller.js";
import { getState, setState } from "../store.js";
import type { Rect } from "../../doc-model.js";
import { translateOps, type DragState } from "../drag.js";
import { SelectionOverlay } from "./selection-overlay.js";

/**
 * The <canvas> is mounted by ref and then owned entirely by DocController /
 * Viewport / RenderClient — React never re-renders it. That is what keeps the
 * incremental tile compositor's performance intact across the redesign.
 *
 * Panning needs no code: `.stage` is `overflow: auto`, and Viewport.visibleTiles
 * reads its scroll offsets, so native scrolling IS the pan gesture (the same
 * arrangement as before the redesign).
 *
 * `.stage-inner` wraps the canvas and `<SelectionOverlay />` together and is
 * the thing that shrink-wraps + centres (`margin: auto`) inside `.stage`'s
 * flex row. That makes `.stage-inner` — not `.stage` — the nearest positioned
 * ancestor for the overlay's `position: absolute`, so the overlay's
 * containing block IS the canvas's box by construction, correct even when
 * `.stage` is larger than the canvas and centres it. Computing a JS offset
 * between `.stage` and the canvas instead would go stale on scroll/resize;
 * a shared containing block does not.
 */
export function CanvasStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  // Marquee drag origin, in document pixels. A ref, not state: it changes on
  // every pointermove and must not re-render the tree mid-drag.
  const anchor = useRef<{ x: number; y: number } | null>(null);
  // Move-tool drag state. Also a ref: it advances every pointermove and must
  // not re-render the tree mid-drag.
  const drag = useRef<DragState | null>(null);

  useEffect(() => {
    if (stageRef.current && viewRef.current) initController(viewRef.current, stageRef.current);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c) return;
    const s = getState();
    if (s.tool === "eyedrop") {
      setState({ pickedColor: c.pickColor(e.clientX, e.clientY) });
      return;
    }
    if (s.tool === "move" && s.selection.length > 0) {
      const at = c.toCanvas(e.clientX, e.clientY);
      drag.current = { layerIds: [...s.selection], from: at, last: at };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (s.tool === "marquee") {
      anchor.current = c.toCanvas(e.clientX, e.clientY);
      setState({ marquee: null });
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c) return;
    if (drag.current) {
      const to = c.toCanvas(e.clientX, e.clientY);
      const ops = translateOps(drag.current, to);
      for (const op of ops) void dispatch(op);
      // Advance `last` by the WHOLE PIXELS actually dispatched, not to `to`:
      // otherwise the sub-pixel remainder translateOps discarded would be lost
      // on every frame and the layer would drift behind the cursor.
      const [dx, dy] = (ops[0]?.payload.op as { translate: [number, number] } | undefined)?.translate ?? [0, 0];
      drag.current = { ...drag.current, last: { x: drag.current.last.x + dx, y: drag.current.last.y + dy } };
      return;
    }
    if (!anchor.current) return;
    setState({ marquee: normalise(anchor.current, c.toCanvas(e.clientX, e.clientY)) });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drag.current && !anchor.current) return;
    drag.current = null;
    anchor.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="stage"
      ref={stageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="stage-inner">
        <canvas className="view" ref={viewRef} aria-label="rendered preview" />
        <SelectionOverlay />
      </div>
    </div>
  );
}

/** Two document-space points → an integer [top,left,bottom,right] rect, in the
 *  engine's convention, regardless of which way the drag went. */
function normalise(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return [
    Math.round(Math.min(a.y, b.y)), Math.round(Math.min(a.x, b.x)),
    Math.round(Math.max(a.y, b.y)), Math.round(Math.max(a.x, b.x)),
  ];
}
