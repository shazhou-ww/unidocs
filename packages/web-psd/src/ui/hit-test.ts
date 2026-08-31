import type { LocalLayer, Rect } from "../doc-model.js";

/**
 * The layer axis: pure geometry and set arithmetic over the layer tree. No
 * DOM, no store, no Worker — the actual alpha sampling lives in the render
 * Worker (see doc-controller's hitTest), and this module is what both the
 * synchronous callers and that async result are shaped by.
 */

/** One candidate under the cursor. `path` runs outermost group → leaf, with
 *  `path[path.length - 1] === layerId`, so the caller picks the level it wants
 *  (single click, double click and ⌘-click each want a different one) instead
 *  of the hit test deciding for everyone. */
export interface Hit {
  layerId: string;
  path: string[];
}

/**
 * Async from the very first version even where the answer is already known,
 * because the real implementation is a postMessage round trip to the render
 * Worker: a synchronous stand-in would have every call site rewritten when it
 * lands.
 *
 * Resolves with the candidate stack under the point, topmost first — empty on
 * a miss. Spec §5.2 writes this as a single `Hit | null`; the stack is a
 * superset, and both Alt-cycling and the right-click list need it. It costs
 * nothing extra: the hit test walks that stack anyway.
 */
export type HitTester = (x: number, y: number) => Promise<Hit[]>;

export function findLayer(layers: LocalLayer[], id: string): LocalLayer | null {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) {
      const found = findLayer(l.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function unionRect(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/**
 * The rect a selection box should be drawn around.
 *
 * A GROUP'S OWN `bounds` IS NOT USABLE. `psd/load.ts:230` maps ag-psd's
 * top/left/bottom/right for every layer alike, and a PSD section divider
 * reports `0,0,0,0` — a group is a render scope (blend, opacity, mask), not a
 * spatial container, so it has no extent of its own and one has to be derived
 * from its visible children.
 *
 * Deliberately `bounds` and not `layerInfluenceBounds` (region.ts:14): the
 * latter includes stroke spread and drop-shadow offset, so a layer with a big
 * shadow would get a selection box floating well clear of the thing it is
 * selecting. Photoshop's transform box hugs the bounds too.
 */
export function layerBox(layer: LocalLayer): Rect | null {
  if (!layer.children) return layer.bounds ?? null;
  let box: Rect | null = null;
  for (const child of layer.children) {
    if (!child.visible) continue;
    const b = layerBox(child);
    if (b) box = box ? unionRect(box, b) : b;
  }
  return box;
}

/** Region axis → layer axis (spec §6.2): every top-level layer whose box meets
 *  `bounds`. Box-level, not per-pixel, on purpose — over-selecting is
 *  recoverable (the user deselects), missing something is not. Top-level only,
 *  which also means the result is already normalized. */
export function layersIntersecting(layers: LocalLayer[], bounds: Rect): string[] {
  const [rt, rl, rb, rr] = bounds;
  const out: string[] = [];
  for (const layer of layers) {
    const box = layerBox(layer);
    if (!box) continue;
    const [t, l, b, r] = box;
    if (t < rb && b > rt && l < rr && r > rl) out.push(layer.id);
  }
  return out;
}

/** id → its ancestor ids, outermost first. */
function ancestorIndex(layers: LocalLayer[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const walk = (list: LocalLayer[], chain: string[]): void => {
    for (const l of list) {
      index.set(l.id, chain);
      if (l.children) walk(l.children, [...chain, l.id]);
    }
  };
  walk(layers, []);
  return index;
}

/**
 * Reduces a selection to members that are not descendants of one another, and
 * drops ids the document no longer has.
 *
 * Both halves prevent the same class of bug — a selection that looks fine and
 * behaves wrongly. `ops/geometry-ops.ts`'s `shiftLayer` recurses into
 * children, while `drag.ts`'s `translateOps` emits one translate per selected
 * id, so a group selected alongside its own child moves that child TWICE. And
 * a dead id is invisible on screen (`selectedLayers` filters it out at read
 * time) yet still gets dispatched as if it were real.
 *
 * Applied at the WRITE side rather than before a drag: the properties pane,
 * the context bar's count and the layer list sent to the agent would all
 * misreport a double-counted selection.
 */
export function normalizeSelection(layers: LocalLayer[], ids: string[]): string[] {
  const index = ancestorIndex(layers);
  const present = new Set(ids.filter((id) => index.has(id)));
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (seen.has(id)) return false;
    const chain = index.get(id);
    if (!chain || chain.some((a) => present.has(a))) return false;
    seen.add(id);
    return true;
  });
}

/** Every ancestor group of `id`, added to `expanded` — `flattenTree` only
 *  emits a group's children when the group is in that set, so a canvas
 *  selection would otherwise land on a row the tree is not rendering.
 *  Returns the SAME set when nothing has to open, so React sees no change. */
export function expandAncestors(
  layers: LocalLayer[], id: string, expanded: ReadonlySet<string>,
): ReadonlySet<string> {
  const chain = ancestorIndex(layers).get(id);
  if (!chain || chain.every((a) => expanded.has(a))) return expanded;
  const next = new Set(expanded);
  for (const a of chain) next.add(a);
  return next;
}
