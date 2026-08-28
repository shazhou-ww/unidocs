import { useEffect, useRef } from "react";
import { getController, initController } from "../controller.js";
import { getState, setState } from "../store.js";
import type { Rect } from "../../doc-model.js";
import { SelectionOverlay } from "./selection-overlay.js";

/**
 * The <canvas> is mounted by ref and then owned entirely by DocController /
 * Viewport / RenderClient — React never re-renders it. That is what keeps the
 * incremental tile compositor's performance intact across the redesign.
 *
 * Panning needs no code: `.stage` is `overflow: auto`, and Viewport.visibleTiles
 * reads its scroll offsets, so native scrolling IS the pan gesture (the same
 * arrangement as before the redesign).
 */
export function CanvasStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  // Marquee drag origin, in document pixels. A ref, not state: it changes on
  // every pointermove and must not re-render the tree mid-drag.
  const anchor = useRef<{ x: number; y: number } | null>(null);

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
    if (s.tool === "marquee") {
      anchor.current = c.toCanvas(e.clientX, e.clientY);
      setState({ marquee: null });
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c || !anchor.current) return;
    setState({ marquee: normalise(anchor.current, c.toCanvas(e.clientX, e.clientY)) });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!anchor.current) return;
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
      <canvas className="view" ref={viewRef} aria-label="rendered preview" />
      <SelectionOverlay />
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
