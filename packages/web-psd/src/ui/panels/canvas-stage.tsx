import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { dispatch, getController, initController } from "../controller.js";
import { getState, selectedLayers, setState, useUiState } from "../store.js";
import { zoomBy } from "../zoom-controller.js";
import { normalizeWheelDelta, wheelZoomFactor } from "../zoom.js";
import type { Rect } from "../../doc-model.js";
import { translateOps, withinBounds, type DragState } from "../drag.js";
import { SelectionOverlay } from "./selection-overlay.js";

/**
 * The <canvas> is mounted by ref and then owned entirely by DocController /
 * Viewport / RenderClient — React never re-renders it. That is what keeps the
 * incremental tile compositor's performance intact across the redesign.
 *
 * Panning is `.stage`'s own scrolling: it is `overflow: auto`, and
 * Viewport.visibleTiles reads its scroll offsets, so a wheel/trackpad scroll
 * IS the pan gesture and needs no code at all. The move tool's drag-to-pan
 * below is the same thing driven from a pointer — it only writes
 * `scrollLeft`/`scrollTop`, so it goes through the identical path.
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
  // Pan drag state: the pointer position and the stage's scroll offsets as
  // they were when the press landed, so every frame can be computed from the
  // ORIGINAL press rather than accumulating per-frame deltas (which would
  // drift once a scroll hits the end of its range and clamps). A ref for the
  // same reason as the two above.
  const pan = useRef<{ clientX: number; clientY: number; left: number; top: number } | null>(null);

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
      if (delta !== 0) zoomBy(wheelZoomFactor(delta), anchor);
    };

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel stays a scroll (= pan)
      e.preventDefault();
      pendingDelta += normalizeWheelDelta(e.deltaY, e.deltaMode);
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
    // The move tool means two things, told apart by WHERE the press lands.
    // On a selected layer it drags that layer; anywhere else it pans the
    // view — the hand gesture, which is what a press on empty canvas reads
    // as and what the `grab`/`grabbing` cursor has just promised. Before
    // this, a press off a selection did nothing at all, so the tool looked
    // dead until you had been to the layer tree first.
    if (s.tool === "move") {
      const at = c.toCanvas(e.clientX, e.clientY);
      const stage = e.currentTarget;
      if (s.selection.length > 0 && withinBounds(selectedLayers(s), at)) {
        drag.current = { layerIds: [...s.selection], from: at, last: at };
      } else {
        // Panning is `.stage`'s native scrolling (see the note at the top of
        // this file), so there is nothing to move but its scroll offsets —
        // and DocController already listens for `scroll` on it, which is what
        // fetches the tiles the pan exposes.
        pan.current = { clientX: e.clientX, clientY: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
        stage.setAttribute("data-panning", "");
      }
      stage.setPointerCapture(e.pointerId);
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
    if (pan.current) {
      // Content follows the cursor (grab the page and move it), which is the
      // opposite sign to moving a scrollbar.
      e.currentTarget.scrollLeft = pan.current.left - (e.clientX - pan.current.clientX);
      e.currentTarget.scrollTop = pan.current.top - (e.clientY - pan.current.clientY);
      return;
    }
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
    if (anchor.current) {
      setState({ marquee: normalise(anchor.current, c.toCanvas(e.clientX, e.clientY), getState().doc?.canvas ?? null) });
      return;
    }
    // Idle hover under the move tool: flag whether the cursor is over a
    // layer it would drag, so the cursor can say `move` there and `grab`
    // (pan) everywhere else. Written as a DOM attribute rather than store
    // state deliberately — this changes on nearly every pointermove, and
    // routing it through the store would re-render the whole tree at the
    // pointer's sample rate for a cursor change.
    const s = getState();
    e.currentTarget.toggleAttribute(
      "data-over-layer",
      s.tool === "move" && s.selection.length > 0
        && withinBounds(selectedLayers(s), c.toCanvas(e.clientX, e.clientY)),
    );
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!drag.current && !anchor.current && !pan.current) return;
    drag.current = null;
    anchor.current = null;
    pan.current = null;
    e.currentTarget.removeAttribute("data-panning");
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
      // Drives the cursor from CSS (see styles.css). The tool is the only
      // thing that decides what a press will do, so it is also the only
      // honest source for what the cursor should promise.
      data-tool={s.tool}
      ref={stageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Deliberately names no file format. PSD is the only one that loads
          today, but PNG/JPEG are planned, and the file picker's `accept`
          already states what is actually supported — so this copy does not
          have to be revisited when that changes. */}
      {s.doc ? null : (
        <p className="stage-empty">
          还没有打开文档
          <span>用右上角的「打开」选择一个文件</span>
        </p>
      )}
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
): CSSProperties {
  // With no document open the canvas would otherwise show at its intrinsic
  // 300x150 with `.view`'s white fill and shadow — a small blank card floating
  // mid-stage that reads as a failed load. It cannot be unmounted (the
  // controller holds it by ref for the lifetime of the page), so hide it and
  // let the empty-state message stand alone.
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return { display: "none" };
  return {
    width: Math.round(canvas.width * zoom),
    height: Math.round(canvas.height * zoom),
    imageRendering: zoom >= 1 ? "pixelated" : "auto",
  };
}
