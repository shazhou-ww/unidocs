import { useEffect } from "react";
import { findLayer, type Hit } from "../hit-test.js";
import { setSelection, useUiState } from "../store.js";

/**
 * The candidate list for a right-click.
 *
 * One click landing on several plausible layers is the NORMAL case in a PSD,
 * not an edge case (spec §3.4): layers are a paint-order stack with arbitrary
 * overlap and one visual object is often several of them. Rather than guessing
 * which one was meant — where being wrong means selecting something invisible
 * and then dragging it — the whole stack is offered, topmost first.
 */
export function HitMenu({ at, hits, onClose }: {
  at: { x: number; y: number } | null;
  hits: Hit[];
  onClose: () => void;
}) {
  const s = useUiState();
  useEffect(() => {
    if (!at) return; // closed: no listener at all, so the app's own Escape shortcut works normally
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    // `app.tsx`'s `useSelectionShortcuts` binds its own bubble-phase Escape
    // listener on `window`, unconditionally, once, at mount — long before
    // this menu ever opens. Two listeners on the SAME node in the SAME phase
    // fire in REGISTRATION order, and `stopImmediatePropagation` only blocks
    // listeners still to come — it cannot retroactively stop one that
    // already ran. So a bubble-phase listener here, however it is gated,
    // always loses the race to App's earlier one; verified by dispatching an
    // Escape as App's own tests do and observing the selection get cleared
    // anyway. Capture phase fixes this structurally rather than by timing:
    // in one dispatch, `window`'s capture-phase listeners ALWAYS run before
    // ANY of its bubble-phase listeners, regardless of when each was added —
    // capture is a full pass down before the bubble pass back up ever
    // starts. (This only matters when the event actually bubbles up through
    // window, i.e. targets a real focused element, as a real keypress does —
    // not when a test dispatches directly on `window` itself, which has no
    // separate capture/bubble timeline and would still resolve by
    // registration order; the plain-Escape tests in
    // canvas-stage-select.test.tsx do exactly that, and are unaffected
    // because they never have a menu open in the first place.)
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [at, onClose]);

  if (!at || hits.length === 0) return null;
  return (
    <div className="hit-menu" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      {hits.map((h) => (
        <button key={h.layerId} type="button"
                onClick={() => { setSelection([h.layerId]); onClose(); }}>
          {findLayer(s.doc?.layers ?? [], h.layerId)?.name ?? h.layerId}
        </button>
      ))}
    </div>
  );
}
