import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { dispatch, getController, initController } from "../controller.js";
import { getState, setState, setRegion, setSelection, selectLayer, useUiState } from "../store.js";
import { zoomBy } from "../zoom-controller.js";
import { normalizeWheelDelta, wheelZoomFactor } from "../zoom.js";
import type { Rect } from "../../doc-model.js";
import { translateOps, type DragState } from "../drag.js";
import { rectRegion } from "../region.js";
import { findLayer, layerBox, type Hit } from "../hit-test.js";
import { SelectionOverlay } from "./selection-overlay.js";
import { SelectionBox } from "./selection-box.js";

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
  // The gesture that is waiting on an async hit test. A ref, not state, for
  // the same reason `drag` is: it changes mid-gesture and must not re-render.
  const pending = useRef<PendingHit | null>(null);

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
    if (s.tool === "move") {
      const at = c.toCanvas(e.clientX, e.clientY);
      e.currentTarget.setPointerCapture(e.pointerId);
      // Pressing inside the existing selection continues to drag it, with no
      // round trip — the gesture the user is most likely to repeat stays
      // instant. A box test is enough here BECAUSE it cannot select anything:
      // it only decides whether to keep dragging what is already selected.
      // (Today's code drags on `selection.length > 0` with no position test at
      // all, so this is strictly narrower.)
      if (s.selection.length > 0 && insideSelection(s, at)) {
        // A new gesture supersedes any hit still in flight from a previous
        // one, whichever path it takes — otherwise a late-arriving hit from
        // an earlier click (released before it landed) can still pass
        // `settleHit`'s `pending.current !== p` guard and overwrite the
        // selection this drag is using, mid-drag.
        pending.current = null;
        drag.current = { layerIds: [...s.selection], from: at, last: at };
        return;
      }
      const p: PendingHit = {
        anchor: at, latest: at, pointerId: e.pointerId, alive: true,
        additive: e.shiftKey, leaf: e.metaKey || e.ctrlKey,
      };
      pending.current = p;
      void c.hitTest(e.clientX, e.clientY)
        .then((hits) => settleHit(p, hits))
        // A Worker-side error rejects the hit test (see RenderClient.hitTest).
        // Without this, `pending.current` would never clear on that gesture,
        // and every subsequent pointermove would fall into the "hit still in
        // flight" branch and dispatch nothing until a fresh pointerdown
        // overwrites it — plus an unhandled rejection.
        .catch(() => { if (pending.current === p) pending.current = null; });
      return;
    }
    if (s.tool === "marquee") {
      anchor.current = c.toCanvas(e.clientX, e.clientY);
      setRegion(null);
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
    // The hit test has not come back yet: record where the finger is and
    // dispatch NOTHING. Moving from the hit's own coordinate later would drop
    // everything travelled during the round trip.
    if (pending.current) {
      pending.current.latest = c.toCanvas(e.clientX, e.clientY);
      return;
    }
    if (!anchor.current) return;
    setRegion(rectRegion(normalise(anchor.current, c.toCanvas(e.clientX, e.clientY), getState().doc?.canvas ?? null)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Released before the hit landed: keep the object so the late result can
    // finish it off as a CLICK. Dropping it here instead would leave the
    // layer following the cursor after the button was let go.
    if (pending.current) pending.current.alive = false;
    if (!drag.current && !anchor.current && !pending.current) return;
    drag.current = null;
    anchor.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const settleHit = (p: PendingHit, hits: Hit[]): void => {
    if (pending.current !== p) return;   // a newer gesture already superseded this one
    pending.current = null;
    const hit = hits[0] ?? null;
    if (!hit) {
      // Clearing the LAYER axis only. The region survives: the two axes are
      // written by different tools and never clear each other (spec §3.3).
      setSelection([]);
      return;
    }
    const id = p.leaf ? hit.path[hit.path.length - 1] : hit.path[0];
    // Routed through `selectLayer`, not a raw `setState`, so a canvas click
    // gets the same ancestor-expansion `selectLayer` already gives a tree
    // click (spec §9) — otherwise picking a nested layer on the canvas would
    // leave the tree collapsed on it.
    selectLayer(id, { additive: p.additive });
    const selection = getState().selection;
    if (!p.alive) return;                // it was a click, not a drag
    const c = getController();
    if (!c) return;
    // `drag.from` is where the finger went DOWN, and the whole distance
    // travelled since is applied in one go — so the layer's total movement
    // always equals the finger's, however long the round trip took.
    const started: DragState = { layerIds: selection, from: p.anchor, last: p.anchor };
    const ops = translateOps(started, p.latest);
    for (const op of ops) void dispatch(op);
    const [dx, dy] = (ops[0]?.payload.op as { translate: [number, number] } | undefined)?.translate ?? [0, 0];
    drag.current = { ...started, last: { x: p.anchor.x + dx, y: p.anchor.y + dy } };
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
        <SelectionBox />
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

/** A gesture whose hit test has not answered yet. */
interface PendingHit {
  anchor: { x: number; y: number };
  latest: { x: number; y: number };
  pointerId: number;
  /** False once the pointer has been released — the late hit then resolves as
   *  a click rather than starting a drag. */
  alive: boolean;
  additive: boolean;
  leaf: boolean;
}

/** Whether a press lands within the boxes of the current selection. Used only
 *  to decide "keep dragging what is already selected", never to select
 *  anything — box-level hit testing is exactly what §5.1 rules out as a way
 *  to pick a layer, because a full-canvas mostly-transparent layer is the
 *  norm in a PSD. */
function insideSelection(s: ReturnType<typeof getState>, at: { x: number; y: number }): boolean {
  if (!s.doc) return false;
  for (const id of s.selection) {
    const layer = findLayer(s.doc.layers, id);
    const box = layer ? layerBox(layer) : null;
    if (box && at.y >= box[0] && at.x >= box[1] && at.y < box[2] && at.x < box[3]) return true;
  }
  return false;
}
