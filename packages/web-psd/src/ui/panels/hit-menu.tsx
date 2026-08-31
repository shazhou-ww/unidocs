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
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
