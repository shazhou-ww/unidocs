import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { dispatch, getController, initController } from "../controller.js";
import { getState, setState, setRegion, setSelection, selectLayer, reportError, useUiState } from "../store.js";
import { setHoverId } from "../overlay-store.js";
import { zoomBy } from "../zoom-controller.js";
import { normalizeWheelDelta, wheelZoomFactor } from "../zoom.js";
import type { Rect } from "../../doc-model.js";
import { translateOps, type DragState } from "../drag.js";
import { rectRegion } from "../region.js";
import { findLayer, layerBox, clickTarget, descendPath, draggableIds, type Hit } from "../hit-test.js";
import { SelectionOverlay } from "./selection-overlay.js";
import { SelectionBox } from "./selection-box.js";
import { HitMenu } from "./hit-menu.js";

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
  // The one supersession token, shared by every gesture that can issue an
  // async hit test: press-drag, double click, alt-cycle and right-click. Each
  // bumps it on the way in, captures the new value, and every `.then` bails if
  // it has moved since.
  //
  // One counter rather than a rule per handler BECAUSE the handlers cannot be
  // reasoned about one at a time. Four gestures now issue hit tests against
  // the same two-axis target, each 20–30ms in flight (longer behind a tile
  // batch), and they interleave in whatever order the user produces — a double
  // click's descent still travelling while a press starts a drag, an alt-click
  // landing after a right-click opened the menu. With a token per handler
  // ("`pending` is still mine", "the `docId` has not moved", and for the
  // double click nothing at all) each pair had to be checked separately, and
  // the double-click/press-drag pair was in fact broken: the descent landed
  // after the drag had already captured the previous selection, so the tree
  // jumped to one layer while the canvas went on moving another. A monotonic
  // counter makes "a newer gesture wins" true by construction for every pair,
  // including pairs added later.
  //
  // It deliberately does NOT subsume the right-click's `docId` check: a
  // document swap replaces the layers under an in-flight hit without any new
  // gesture, which a gesture counter cannot see. The two guards answer
  // different questions and both stay.
  const gesture = useRef(0);
  // Where the last alt-click landed and how deep into that point's candidate
  // stack it had got. Keyed by the rounded document coordinate so moving away
  // and coming back starts over rather than resuming somewhere arbitrary.
  const cycle = useRef<{ key: string; index: number } | null>(null);
  // Hover hit tests are throttled to one per frame and only run under the move
  // tool. The result goes to overlay-store, NOT the main store: the main store
  // notifies every subscriber, so a per-frame hover would re-render the whole
  // layer tree (store.ts:106).
  const hoverFrame = useRef(0);
  // The right-click candidate menu. Local state, not the main store: it
  // belongs to this component alone.
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; hits: Hit[] } | null>(null);
  // Stable across renders because <HitMenu /> lists it in the deps of the
  // effect that registers its capture-phase Escape listener. A fresh closure
  // every render tears that listener down and re-registers it on every single
  // CanvasStage render for as long as the menu is open — and the store
  // notifies every subscriber on every change, so those renders are frequent.
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (stageRef.current && viewRef.current) initController(viewRef.current, stageRef.current);
  }, []);

  useEffect(() => {
    if (s.tool !== "move") setHoverId(null);
    // This cleanup runs on every `s.tool` change, not only unmount. If a
    // hover frame is in flight when the tool changes, cancelling it without
    // also resetting the ref would leave `hoverFrame.current` stuck on a dead
    // id forever — the rAF callback is the only other place that zeroes it,
    // and it will never run now. `onPointerMove`'s `hoverFrame.current === 0`
    // gate would then stay closed for the rest of the component's life, even
    // after switching back to the move tool.
    return () => {
      if (hoverFrame.current !== 0) {
        cancelAnimationFrame(hoverFrame.current);
        hoverFrame.current = 0;
      }
    };
  }, [s.tool]);

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

  /**
   * The single failure path for every gesture's hit test.
   *
   * `RenderClient.hitTest` genuinely rejects — the render Worker posts
   * `{type:"error"}` for any throw inside `core.hitTest`, and a CAS blob fetch
   * failing inside `residentFor` is an ordinary route there, not an
   * emergency. Clearing the gesture state matters as much as the message:
   * leaving `pending` set means every later `pointermove` falls into the "hit
   * still in flight" branch and dispatches nothing until a fresh press.
   *
   * Returns whether this gesture is still the current one, so a caller with
   * extra state of its own (the menu) can clean up without repeating the
   * check.
   */
  const hitFailed = (g: number, err: unknown, p: PendingHit | null = null): boolean => {
    // Hand the slot back FIRST, superseded or not: this gesture is the one
    // that took it, and `onPointerMove` reads a non-null `pending` as "a hit
    // is still coming". See `settleHit` for the case that makes this matter.
    if (p && pending.current === p) pending.current = null;
    if (gesture.current !== g) return false;  // a newer gesture owns the report now
    pending.current = null;
    reportError("命中测试失败", err);
    return true;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (menu) setMenu(null);
    // A secondary click fires `pointerdown` too, and the browser sends it
    // BEFORE `contextmenu`. Without this, right-clicking to say "I don't know
    // which of these you meant" first took pointer capture, fired a hit test
    // and selected `clickTarget`'s guess — so the menu opened over a selection
    // it had already disturbed, and dismissing it with Escape left behind a
    // selection the user never asked for, which is the whole point of the
    // feature undone. On macOS it compounds: ⌃-click IS the secondary click
    // and also sets `e.ctrlKey`, so it took the `p.leaf` "drill to the leaf"
    // branch as well.
    if (e.button !== 0) return;
    const g = ++gesture.current;
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
      // Alt held is excluded: the whole point of alt-cycling is to re-probe
      // the stack under the cursor even though the previous candidate it
      // selected is sitting right there, so this fast path must not swallow
      // the click into a drag instead.
      if (!e.altKey && s.selection.length > 0 && insideSelection(s, at)) {
        // Bumping `gesture` above already superseded anything in flight —
        // including a double click's descent, which this branch used to run
        // straight past. `pending` is cleared too so `onPointerMove` does not
        // sit in its "hit still in flight" branch for the rest of the drag.
        pending.current = null;
        drag.current = { layerIds: [...s.selection], from: at, last: at };
        return;
      }
      const p: PendingHit = {
        anchor: at, latest: at, alive: true,
        additive: e.shiftKey, leaf: e.metaKey || e.ctrlKey, cycle: e.altKey,
      };
      pending.current = p;
      // A two-argument `then`, not `.then(...).catch(...)`: a rejection
      // handler chained AFTER the fulfillment handler cannot tell a genuine
      // Worker failure from a bug thrown inside `settleHit`, and the previous
      // single `.catch` reported neither. This way only the hit test's own
      // rejection reaches `hitFailed`; a `settleHit` throw stays a real,
      // visible error rather than being reported as a failed hit test.
      void c.hitTest(e.clientX, e.clientY).then(
        (hits) => settleHit(g, p, hits),
        (err) => hitFailed(g, err, p),
      );
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
    if (getState().tool === "move" && !anchor.current && hoverFrame.current === 0) {
      const { clientX, clientY } = e;
      hoverFrame.current = requestAnimationFrame(() => {
        hoverFrame.current = 0;
        void c.hitTest(clientX, clientY, { hover: true }).then(
          (hits) => setHoverId(hits[0]?.layerId ?? null),
          // Deliberately silent, and the ONE async hit site that is. This runs
          // once per animation frame, and a hover failure repeats for as long
          // as the cursor keeps moving — `reportError` appends to the chat
          // transcript, so reporting here would bury every real message under
          // hundreds of identical lines. The outline is cosmetic; drop it and
          // say nothing. Still a handler and not an omission, because an
          // unhandled rejection per frame is its own noise.
          () => setHoverId(null),
        );
      });
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

  const settleHit = (g: number, p: PendingHit, hits: Hit[]): void => {
    // The slot goes back BEFORE the supersession check, and only if this
    // gesture still owns it. Not every superseding gesture installs a
    // `pending` of its own — a right-click bumps the token and installs
    // nothing — so leaving it set on the superseded path would park
    // `onPointerMove` in its "a hit is still coming" branch permanently: no
    // hover, no marquee, until the next press happened to overwrite it.
    if (pending.current === p) pending.current = null;
    if (gesture.current !== g) return;   // a newer gesture already superseded this one
    const hit = hits[0] ?? null;
    if (!hit) {
      // Clearing the LAYER axis only. The region survives: the two axes are
      // written by different tools and never clear each other (spec §3.3).
      setSelection([]);
      return;
    }
    if (p.cycle) {
      const key = `${Math.round(p.anchor.x)},${Math.round(p.anchor.y)}`;
      const index = cycle.current?.key === key ? (cycle.current.index + 1) % hits.length : 0;
      cycle.current = { key, index };
      // `selectLayer`, not `setSelection`: this is a selection made ON THE
      // CANVAS, so spec §9's tree expansion applies exactly as it does to the
      // ordinary click below. Alt-cycling reaches layers buried under others,
      // which are the ones the tree is least likely to be showing already.
      selectLayer(hits[index].layerId);
      return;
    }
    const s2 = getState();
    const id = p.leaf
      ? hit.path[hit.path.length - 1]
      : clickTarget(s2.doc?.layers ?? [], hit.path, s2.doc?.canvas ?? { width: 0, height: 0 });
    // Routed through `selectLayer`, not a raw `setState`, so a canvas click
    // gets the same ancestor-expansion `selectLayer` already gives a tree
    // click (spec §9) — otherwise picking a nested layer on the canvas would
    // leave the tree collapsed on it.
    selectLayer(id, { additive: p.additive });
    const selection = getState().selection;
    if (!p.alive) return;                // it was a click, not a drag
    const c = getController();
    if (!c) return;
    const movable = draggableIds(s2.doc?.layers ?? [], selection);
    if (movable.length === 0) return;    // locked: selected, but nothing to move (the engine will not refuse it for us)
    // `drag.from` is where the finger went DOWN, and the whole distance
    // travelled since is applied in one go — so the layer's total movement
    // always equals the finger's, however long the round trip took.
    const started: DragState = { layerIds: movable, from: p.anchor, last: p.anchor };
    const ops = translateOps(started, p.latest);
    for (const op of ops) void dispatch(op);
    const [dx, dy] = (ops[0]?.payload.op as { translate: [number, number] } | undefined)?.translate ?? [0, 0];
    drag.current = { ...started, last: { x: p.anchor.x + dx, y: p.anchor.y + dy } };
  };

  // Descends one level into the group the last click selected. Uses the same
  // candidate stack as the click, so the two can never disagree about which
  // path the cursor is on.
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c || getState().tool !== "move") return;
    // The second `pointerdown` of the double click already started its own
    // async settle (`p2`) before this handler runs. Bumping the token
    // supersedes it, stopping it from landing after the descent below and
    // flashing the single-click target — otherwise the two hit tests race and
    // only a strictly-FIFO queue happens to save the descent. `pending` is
    // cleared as well so `onPointerMove` does not sit in its "hit still in
    // flight" branch afterwards.
    const g = ++gesture.current;
    pending.current = null;
    void c.hitTest(e.clientX, e.clientY).then(
      (hits) => {
        if (gesture.current !== g) return;  // a newer gesture already superseded this one
        const hit = hits[0];
        // A miss clears the layer axis, exactly as a single click's miss does
        // (`settleHit` above) — and the region survives, as always. Returning
        // early here instead meant a double click on blank canvas cleared
        // NOTHING: both pointerdown settles bail (superseded, and `pending`
        // nulled above), so nobody was left to act on the miss.
        if (!hit) { setSelection([]); return; }
        // `selectLayer`, not `setSelection`: the descent is the worst of the
        // three canvas paths that skipped spec §9's expansion, because it
        // selects a child that is BY CONSTRUCTION behind a collapsed group —
        // `expandAncestors` opens the ancestor chain, so having selected the
        // group never opened that group itself.
        selectLayer(descendPath(hit.path, getState().selection[0] ?? ""));
      },
      (err) => hitFailed(g, err),
    );
  };

  // Right-click lists every candidate under the cursor instead of guessing
  // which one was meant (spec §3.4) — the whole stack `hitTest` already
  // returns, handed to <HitMenu /> for the user to pick from directly.
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const c = getController();
    if (!c || getState().tool !== "move") return;
    e.preventDefault();
    const g = ++gesture.current;
    const box = e.currentTarget.getBoundingClientRect();
    const at = { x: e.clientX - box.left + e.currentTarget.scrollLeft, y: e.clientY - box.top + e.currentTarget.scrollTop };
    // `CanvasStage` is never re-keyed on a new document (app.tsx renders it
    // unconditionally), so this component — and this in-flight promise —
    // survive a document swap. Without capturing which doc the click was
    // against, a right-click followed by loading a different PSD before the
    // hit resolves would show the OLD document's layers, positioned in the
    // old canvas's coordinates.
    //
    // Compared by `docId`, not the `doc` object's identity: `onDoc`
    // (controller.ts) replaces `doc` with a fresh object on every dispatched
    // op, every rebase, and every agent reconcile — not only on a genuine
    // open. Comparing object identity would trip on any unrelated edit that
    // lands while the hit test is in flight, silently swallowing the menu
    // for a document that never actually changed. `docId` only moves on a
    // real `openFile` (controller.ts's `createFrom` success path) — the same
    // distinction `sessionDocId` exists to draw, for the same reason.
    //
    // KEPT ALONGSIDE the gesture token rather than replaced by it: a document
    // swap needs no new gesture, so the counter cannot see one. The two
    // guards answer different questions and both earn their place.
    const docId = getState().docId;
    void c.hitTest(e.clientX, e.clientY).then(
      (hits) => {
        if (gesture.current !== g) return;       // a newer gesture superseded this one
        if (getState().docId !== docId) return;  // a different document was opened while this was in flight
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
      ref={stageRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      // The hover hit test only fires on `pointermove` inside `.stage`, so
      // nothing else clears it when the pointer leaves without the tool
      // changing — without this, the last hovered layer's `.sel-hover`
      // outline stays stuck on screen indefinitely.
      onPointerLeave={() => setHoverId(null)}
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
  /** False once the pointer has been released — the late hit then resolves as
   *  a click rather than starting a drag. */
  alive: boolean;
  additive: boolean;
  leaf: boolean;
  /** Alt was held: cycle through the candidate stack instead of picking the
   *  usual level. */
  cycle: boolean;
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
