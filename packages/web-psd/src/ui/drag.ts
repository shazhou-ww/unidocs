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
