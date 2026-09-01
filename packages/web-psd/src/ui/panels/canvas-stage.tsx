import { useEffect, useLayoutEffect, useRef, useState, useCallback, type CSSProperties } from "react";
import { getController, initController } from "../controller.js";
import { getState, reportError, setSelection, selectLayer, setState, useUiState } from "../store.js";
import { zoomBy } from "../zoom-controller.js";
import { normalizeWheelDelta, wheelZoomFactor } from "../zoom.js";
import type { Rect } from "../../doc-model.js";
import { clickTarget, descendPath, type Hit } from "../hit-test.js";
import { setHoverId } from "../overlay-store.js";
import { setRegion } from "../store.js";
import { rectRegion } from "../region.js";
import { SelectionOverlay } from "./selection-overlay.js";
import { SelectionBox } from "./selection-box.js";
import { HitMenu } from "./hit-menu.js";

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
 * document pixels, correct at any zoom — the marquee and the eyedropper share
 * that one mapping, so they cannot disagree about which pixel the cursor is
 * over.
 *
 * The move tool's press does two things that never collide, because one is a
 * CLICK and the other a DRAG: releasing without having moved more than
 * `CLICK_SLOP_PX` selects the layer under the cursor, anything further is the
 * pan above. Nothing is deferred to find that out — the pan runs from the
 * first pixel, and the click is decided in hindsight at `pointerup`, so
 * panning has none of the stickiness a "wait and see" threshold would add.
 * Layer POSITION is still not editable by dragging (see the note above); the
 * click only moves the selection.
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
  // Pan drag state: the pointer position and the stage's scroll offsets as
  // they were when the press landed, so every frame can be computed from the
  // ORIGINAL press rather than accumulating per-frame deltas (which would
  // drift once a scroll hits the end of its range and clamps). A ref for the
  // same reason as the two above.
  const pan = useRef<{ clientX: number; clientY: number; left: number; top: number } | null>(null);
  // One monotonic token for every gesture that fires an async hit test —
  // click, double click and right click alike. Each captures it and bails if
  // it moved, so a newer gesture always wins no matter which kind it is.
  // Four gestures each growing their own staleness rule is what let a stale
  // descent overwrite a newer selection before this existed.
  const gesture = useRef(0);
  // rAF throttle for hover. Zeroed inside the callback AND in the cleanup —
  // the cleanup runs on every tool change, and leaving a dead id here would
  // wedge the gate below permanently.
  const hoverFrame = useRef(0);
  // Where the last Alt-click landed and how deep into that point's candidate
  // stack it has walked. Keyed by rounded document coordinate so moving away
  // and coming back restarts rather than resuming somewhere arbitrary.
  const cycle = useRef<{ key: string; index: number } | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; hits: Hit[] } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

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

  // Hover only means anything under the move tool, which is the only one that
  // selects. The ref is reset as well as cancelled: this cleanup runs on
  // EVERY tool change, and a cancelled frame whose id stayed non-zero would
  // close the gate in `onPointerMove` for the life of the component.
  useEffect(() => {
    if (s.tool !== "move") setHoverId(null);
    return () => {
      if (hoverFrame.current !== 0) cancelAnimationFrame(hoverFrame.current);
      hoverFrame.current = 0;
    };
  }, [s.tool]);

  /** Every async hit test funnels its rejection here. `RenderClient.hitTest`
   *  really does reject — the Worker posts `{type:"error"}` for any throw
   *  inside `core.hitTest`, and a CAS fetch failing mid-hover is an ordinary
   *  way to get there. Returns whether this gesture is still the current one,
   *  so callers can skip cleanup that a newer gesture already owns. */
  const hitFailed = (g: number, err: unknown): boolean => {
    if (gesture.current !== g) return false;
    reportError("命中测试失败", err);
    return true;
  };

  /** The layer-axis write for one canvas click. No drag is established: the
   *  canvas cannot move layers at all (see the file header), so a click only
   *  ever changes what is selected. */
  const settleHit = (g: number, hits: Hit[], at: { x: number; y: number }, mods: { additive: boolean; leaf: boolean; cycle: boolean }): void => {
    if (gesture.current !== g) return;
    const hit = hits[0] ?? null;
    if (!hit) { setSelection([]); return; }
    if (mods.cycle) {
      const key = `${Math.round(at.x)},${Math.round(at.y)}`;
      const index = cycle.current?.key === key ? (cycle.current.index + 1) % hits.length : 0;
      cycle.current = { key, index };
      selectLayer(hits[index].layerId);
      return;
    }
    const st = getState();
    const id = mods.leaf
      ? hit.path[hit.path.length - 1]
      : clickTarget(st.doc?.layers ?? [], hit.path, st.doc?.canvas ?? { width: 0, height: 0 });
    // `selectLayer`, not a raw `setState`: a canvas selection has to expand
    // the tree's ancestor groups the same way a tree click does (spec §9),
    // or picking a nested layer leaves the tree collapsed on it.
    selectLayer(id, { additive: mods.additive });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c) return;
    if (menu) setMenu(null);
    // A secondary press must not run the select/pan path at all: right-click
    // exists to ASK which layer was meant, so disturbing the selection before
    // the menu opens defeats it. (On macOS ⌃-click is the secondary click and
    // also sets `ctrlKey`, which would additionally take the leaf branch.)
    if (e.button !== 0) return;
    const s = getState();
    if (s.tool === "eyedrop") {
      setState({ pickedColor: c.pickColor(e.clientX, e.clientY) });
      return;
    }
    // Dragging the canvas ALWAYS pans, whatever is selected — the move tool
    // is the hand. It used to translate the selected layers instead, which
    // meant the same gesture did two different things depending on state you
    // could not see from the canvas, and that the one gesture the empty grey
    // surround obviously affords (grab it and move it) was the one it did
    // not do. Layer position is not editable by dragging at all now.
    //
    // Panning is `.stage`'s native scrolling (see the note at the top of
    // this file), so there is nothing to move but its scroll offsets — and
    // DocController already listens for `scroll` on it, which is what fetches
    // the tiles the pan exposes.
    if (s.tool === "move") {
      const stage = e.currentTarget;
      pan.current = { clientX: e.clientX, clientY: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      stage.setAttribute("data-panning", "");
      stage.setPointerCapture(e.pointerId);
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
    if (pan.current) {
      // Content follows the cursor (grab the page and move it), which is the
      // opposite sign to moving a scrollbar.
      e.currentTarget.scrollLeft = pan.current.left - (e.clientX - pan.current.clientX);
      e.currentTarget.scrollTop = pan.current.top - (e.clientY - pan.current.clientY);
      return;
    }
    if (anchor.current) {
      setRegion(rectRegion(normalise(anchor.current, c.toCanvas(e.clientX, e.clientY), getState().doc?.canvas ?? null)));
      return;
    }
    // Hover highlight: one hit test per animation frame, move tool only, and
    // marked `hover` so the Worker may drop it rather than let it queue ahead
    // of a tile batch. The result goes to `overlay-store`, never the main
    // store — a per-frame `setState` there would re-render the whole layer
    // tree. Failures are silent by design: reporting one per frame would be
    // worse than the missing outline.
    if (getState().tool === "move" && hoverFrame.current === 0) {
      const { clientX, clientY } = e;
      hoverFrame.current = requestAnimationFrame(() => {
        hoverFrame.current = 0;
        void c.hitTest(clientX, clientY, { hover: true }).then(
          (hits) => setHoverId(hits[0]?.layerId ?? null),
          () => setHoverId(null),
        );
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!anchor.current && !pan.current) return;
    const panned = pan.current;
    anchor.current = null;
    pan.current = null;
    e.currentTarget.removeAttribute("data-panning");
    e.currentTarget.releasePointerCapture(e.pointerId);

    // Decided in hindsight: a press that never travelled `CLICK_SLOP_PX` was
    // a click, so it selects. The pan already ran for those few pixels and is
    // simply invisible at that distance — which is why nothing had to be
    // deferred on the way down.
    const c = getController();
    if (!c || !panned) return;
    if (Math.abs(e.clientX - panned.clientX) > CLICK_SLOP_PX
      || Math.abs(e.clientY - panned.clientY) > CLICK_SLOP_PX) return;
    const g = ++gesture.current;
    const at = c.toCanvas(e.clientX, e.clientY);
    const mods = { additive: e.shiftKey, leaf: e.metaKey || e.ctrlKey, cycle: e.altKey };
    void c.hitTest(e.clientX, e.clientY).then(
      (hits) => settleHit(g, hits, at, mods),
      (err) => hitFailed(g, err),
    );
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c || getState().tool !== "move") return;
    // The two presses of the double click each already fired their own click
    // settle at `pointerup`. Bumping the token supersedes them, so neither
    // can land after the descent and flash the single-click target.
    const g = ++gesture.current;
    void c.hitTest(e.clientX, e.clientY).then(
      (hits) => {
        if (gesture.current !== g) return;
        const hit = hits[0];
        if (!hit) { setSelection([]); return; }
        selectLayer(descendPath(hit.path, getState().selection[0] ?? ""));
      },
      (err) => hitFailed(g, err),
    );
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c || getState().tool !== "move") return;
    e.preventDefault();
    const g = ++gesture.current;
    const box = e.currentTarget.getBoundingClientRect();
    const at = { x: e.clientX - box.left + e.currentTarget.scrollLeft, y: e.clientY - box.top + e.currentTarget.scrollTop };
    // Compared by `docId`, not the `doc` object: `onDoc` replaces `doc` on
    // every dispatched op and every rebase, so object identity would trip on
    // any unrelated edit landing mid-flight and swallow the menu for a
    // document that never changed. Kept ALONGSIDE the gesture token — a
    // document swap needs no new gesture, so the counter cannot see one.
    const docId = getState().docId;
    void c.hitTest(e.clientX, e.clientY).then(
      (hits) => {
        if (gesture.current !== g) return;
        if (getState().docId !== docId) return;
        setMenu(hits.length ? { at, hits } : null);
      },
      (err) => { if (hitFailed(g, err)) setMenu(null); },
    );
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
      // Leaving the canvas ends the hover; nothing else would, so the last
      // outline would otherwise sit there indefinitely.
      onPointerLeave={() => setHoverId(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
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
      <HitMenu at={menu?.at ?? null} hits={menu?.hits ?? []} onClose={closeMenu} />
    </div>
  );
}

/** How far a press may travel and still count as a click rather than a pan,
 *  in CSS pixels. A steady hand stays inside 1-2px when aiming; a pan clears
 *  it on the first frame. */
const CLICK_SLOP_PX = 4;

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
