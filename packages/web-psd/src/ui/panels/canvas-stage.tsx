import { useEffect, useLayoutEffect, useRef } from "react";
import { dispatch, getController, initController } from "../controller.js";
import { getState, setState, useUiState } from "../store.js";
import { zoomBy } from "../zoom-controller.js";
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
 * Zoom is applied HERE and only here, as a CSS width/height on the canvas —
 * the bitmap is always the document at 1:1, and Viewport measures the ratio
 * back off the laid-out box rather than being told it. That is the whole of
 * zoom's effect on rendering: no tile is re-composited, no transform is
 * applied, the browser scales the already-painted bitmap. Every pointer coordinate
 * below therefore goes through `controller.toCanvas()` and comes back in
 * document pixels, correct at any zoom — the marquee, the layer drag and the
 * eyedropper all share that one mapping, so they cannot disagree about which
 * pixel the cursor is over.
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
/** Wheel delta → zoom factor exponent. Exponential so a given scroll distance
 *  is the same RATIO of zoom wherever you are on the scale: a linear step
 *  crawls when zoomed out and lurches when zoomed in. */
const WHEEL_ZOOM_RATE = 0.01;

export function CanvasStage() {
  const s = useUiState();
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

  // Registered by hand rather than as an `onWheel` prop because the handler
  // must call `preventDefault` to stop the browser zooming the whole page,
  // and React attaches wheel listeners passively — where preventDefault is a
  // no-op and logs a console error. Trackpad pinch arrives here too: browsers
  // report it as a wheel event with `ctrlKey` set, so it is handled for free.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    // Coalesced to one zoom per animation frame. A trackpad pinch emits wheel
    // events far faster than the screen refreshes, and each `zoomTo` forces a
    // synchronous render, a layout read and a tile request — running that a
    // hundred times a second is jank, and every extra step is discarded by
    // the next one anyway. Deltas accumulate so no scroll distance is lost;
    // the anchor is the LATEST cursor position, which is where the pinch
    // actually is by the time the frame runs.
    let pendingDelta = 0;
    let anchor = { clientX: 0, clientY: 0 };
    let frame = 0;

    const apply = (): void => {
      frame = 0;
      const delta = pendingDelta;
      pendingDelta = 0;
      if (delta !== 0) zoomBy(Math.exp(-delta * WHEEL_ZOOM_RATE), anchor);
    };

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel stays a scroll (= pan)
      e.preventDefault();
      pendingDelta += e.deltaY;
      anchor = { clientX: e.clientX, clientY: e.clientY };
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", onWheel);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
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
    setState({ marquee: normalise(anchor.current, c.toCanvas(e.clientX, e.clientY), getState().doc?.canvas ?? null) });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drag.current && !anchor.current) return;
    drag.current = null;
    anchor.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const canvasStyle = canvasBoxStyle(s.doc?.canvas ?? null, s.zoom);

  // Anything that changes the canvas's laid-out box exposes a different slice
  // of the document, and the newly-exposed tiles have to be fetched. This is
  // the ONE place that happens, for the same reason the overlay uses
  // percentages: a caller that fetches right after setting the zoom measures
  // the box before React has committed the new size and re-requests exactly
  // the tiles it already had. `useLayoutEffect` runs after the DOM mutation
  // and layout, before paint, so the measurement is correct by construction —
  // and it covers cold start (where the first paint is requested at 1:1
  // before the fit-to-window zoom is applied) and a doc resize from an agent
  // crop, not just the zoom controls.
  useLayoutEffect(() => {
    getController()?.requestVisibleTiles();
  }, [s.zoom, s.doc?.canvas.width, s.doc?.canvas.height]);

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
        <canvas
          className="view"
          ref={viewRef}
          aria-label="rendered preview"
          style={canvasStyle}
        />
        <SelectionOverlay />
      </div>
    </div>
  );
}

/**
 * Two document-space points → an integer [top,left,bottom,right] rect, in the
 * engine's convention, regardless of which way the drag went.
 *
 * Clamped to the document rect. The pointer handlers live on `.stage`, which
 * is `overflow: auto` and larger than the canvas whenever the doc is smaller
 * than the viewport, so a drag that starts (or ends) in the grey surround
 * produces out-of-document coordinates — and `crop` would happily ENLARGE the
 * canvas past its content, or place the selection partly outside it. Clamping
 * here rather than at the pointer boundary keeps the anchor honest even when
 * the drag re-enters the canvas. `canvas` is null before a document has
 * loaded, in which case there is nothing to clamp against.
 */
export function normalise(
  a: { x: number; y: number },
  b: { x: number; y: number },
  canvas: { width: number; height: number } | null,
): Rect {
  const clamp = (v: number, hi: number): number => Math.max(0, Math.min(hi, Math.round(v)));
  if (!canvas) {
    return [
      Math.round(Math.min(a.y, b.y)), Math.round(Math.min(a.x, b.x)),
      Math.round(Math.max(a.y, b.y)), Math.round(Math.max(a.x, b.x)),
    ];
  }
  return [
    clamp(Math.min(a.y, b.y), canvas.height), clamp(Math.min(a.x, b.x), canvas.width),
    clamp(Math.max(a.y, b.y), canvas.height), clamp(Math.max(a.x, b.x), canvas.width),
  ];
}

/**
 * The canvas element's CSS box: the document size scaled by zoom. This is the
 * ONLY place zoom becomes visible — everything else measures it back off this
 * box.
 *
 * Rounded to whole CSS pixels so the box edge lands on a device pixel; the
 * measured ratio then reflects the rounded size, so the mapping stays exact
 * rather than being a hair off from the requested zoom.
 *
 * `imageRendering` switches on the direction of the scale. Magnifying wants
 * `pixelated` — at 400% you are inspecting pixels and smoothing them is the
 * opposite of useful. Minifying wants the browser's smoothing: nearest
 * neighbour when shrinking drops whole rows and columns, which turns fine
 * detail into aliased noise.
 */
export function canvasBoxStyle(
  canvas: { width: number; height: number } | null,
  zoom: number,
): { width: number; height: number; imageRendering: "pixelated" | "auto" } | undefined {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return undefined;
  return {
    width: Math.round(canvas.width * zoom),
    height: Math.round(canvas.height * zoom),
    imageRendering: zoom >= 1 ? "pixelated" : "auto",
  };
}
