import type { LocalLayer } from "../doc-model.js";

export interface DragState {
  layerIds: string[];
  from: { x: number; y: number };
  last: { x: number; y: number };
}

export interface TransformOp { kind: "transform"; payload: Record<string, unknown> }

/**
 * Ops for one drag frame: the INCREMENT since `drag.last`, one per selected
 * layer. Increments (rather than an absolute offset from `drag.from`) keep
 * every op independently applicable and independently reversible, which is
 * what the delta log and /rollback expect.
 *
 * Sub-pixel movement produces no ops at all — the engine's transform takes
 * integer pixels, and rounding each frame independently would accumulate drift.
 */
export function translateOps(drag: DragState, to: { x: number; y: number }): TransformOp[] {
  const dx = Math.round(to.x - drag.last.x);
  const dy = Math.round(to.y - drag.last.y);
  if (dx === 0 && dy === 0) return [];
  return drag.layerIds.map((layerId) => ({
    kind: "transform",
    payload: { layerId, op: { translate: [dx, dy] } },
  }));
}

/**
 * Is a document-space point inside any of these layers' bounding boxes?
 *
 * This is the move tool's disambiguator, not a real hit test: it decides
 * whether a press means "drag this selected layer" or "pan the view", and it
 * only ever runs over the ALREADY-SELECTED layers, so a bounding box is
 * precise enough — the user has already said which layer they mean. Proper
 * per-pixel hit testing (clicking the canvas to CHANGE the selection) is a
 * different problem and belongs off the main thread; see the selection-model
 * design doc.
 *
 * `bounds` is `[top,left,bottom,right]` in the engine's convention, with the
 * right/bottom edges exclusive — matching how the marquee rect is read.
 * A layer with no bounds (never laid out) can never be hit.
 */
export function withinBounds(layers: LocalLayer[], at: { x: number; y: number }): boolean {
  return layers.some((l) => {
    if (!l.bounds) return false;
    const [top, left, bottom, right] = l.bounds;
    return at.x >= left && at.x < right && at.y >= top && at.y < bottom;
  });
}
