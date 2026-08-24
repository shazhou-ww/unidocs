import type { PsdDoc, Layer } from "../model/types.js";
import { layerInfluenceBounds } from "./region.js";
import { findLayer, findParentList, isDescendant } from "../model/tree.js";

type Rect = [number, number, number, number];

const union = (a: Rect, b: Rect): Rect =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

const STRUCTURAL = new Set(["reorder", "remove_layer", "add_layer"]);

/**
 * Layers whose rendered output can diverge when `renderList`'s clip-base state
 * machine is perturbed at `index` of the sibling list `list` — i.e. the maximal
 * run of CONSECUTIVE `clipping` siblings directly above `index`.
 *
 * Why exactly that run, and nothing more (see `renderList` in composite.ts):
 * `baseCoverage` is threaded bottom-to-top and only three things read or write it —
 *   - `!visible`  → base := null when the layer is non-clipping (state RESET,
 *     independent of the incoming value); pass-through when it IS clipping;
 *   - visible + `clipping` + base ≠ null → the layer is CONFINED to that base
 *     (its own output depends on the incoming state) and the base persists, so
 *     a whole run of clipping siblings shares one base;
 *   - visible + (non-clipping OR base === null) → applied UNCONFINED, then
 *     base := (non-adjustment && nextVisible-above is clipping) ? alpha(layer)
 *     : null — again a pure function of the layer itself, so the state is RESET.
 *     (The `base === null` branch is the PROMOTION case: an unconfined visible
 *     clipping layer becomes the base for the clipping layers above it.)
 * So: only a `clipping` sibling's OUTPUT can depend on the incoming state, and
 * the first NON-clipping sibling above the perturbation point (visible or not,
 * adjustment or not) resets the state to a value that does not depend on it.
 * Divergence therefore cannot escape past that layer, and every layer below the
 * perturbation point is untouched (the fold is strictly bottom-to-top).
 *
 * Hidden clipping siblings are kept in the run: they pass the state through, so
 * divergence can travel across them to a visible clipping layer higher up. They
 * contribute nothing themselves, so including their bounds is merely wider.
 */
function clipRunAbove(list: Layer[], index: number): Layer[] {
  const run: Layer[] = [];
  for (let i = index + 1; i < list.length; i++) {
    if (!list[i].clipping) break; // state is reset here — divergence stops
    run.push(list[i]);
  }
  return run;
}

/**
 * The layers (other than the op's own target) whose output this op can change
 * via the clip-base state machine. Empty ⇒ the op is NOT clip-perturbing and
 * the plain union-of-target-influence rule is already a superset.
 *
 * Only two families of ops can perturb the machine, because the machine reads
 * nothing else about a layer than its position, `visible` and `clipping`:
 *  - `set_props` touching `visible` or `clipping` (a `clipping` flip also flips
 *    whether the sibling BELOW computes an alpha base, but that only feeds the
 *    target and the run above it);
 *  - `reorder` / `add_layer` / `remove_layer`, which change list membership and
 *    order — perturbing the state at the target's slot in the source list
 *    (`before`) and at its slot in the destination list (`after`).
 * Everything else (`transform`, `mask_edit`, `adjust`, `generative_fill`,
 * `set_props opacity/blendMode/name/locked`) can only change a base layer's
 * ALPHA, and a confined clip layer's output changes only where that alpha
 * changed — which is inside the target's own influence bounds already.
 *
 * Runs are computed per SIBLING LIST (`findParentList`), matching `renderList`,
 * which recurses into `group.children` with a fresh `baseCoverage = null`.
 */
function perturbedClipRun(
  op: { kind: string; payload: Record<string, unknown> },
  before: PsdDoc,
  after: PsdDoc,
): Layer[] {
  const p = op.payload as { layerId?: string; layer?: { id?: string }; props?: Record<string, unknown> };
  let id: string | undefined;
  if (op.kind === "set_props") {
    const props = p.props ?? {};
    if (!("visible" in props) && !("clipping" in props)) return [];
    id = p.layerId;
  } else if (STRUCTURAL.has(op.kind)) {
    // add_layer names the new layer under `layer`; reorder/remove use `layerId`.
    id = op.kind === "add_layer" ? p.layer?.id : p.layerId;
  } else {
    return [];
  }
  if (!id) return [];
  const run: Layer[] = [];
  for (const doc of [before, after]) {
    const at = findParentList(doc.layers, id);
    if (at) run.push(...clipRunAbove(at.list, at.index));
  }
  return run;
}

export function opDirtyRect(op: { kind: string; payload: Record<string, unknown> }, before: PsdDoc, after: PsdDoc): Rect {
  const canvas = after.canvas;
  const full: Rect = [0, 0, canvas.height, canvas.width];
  if (op.kind === "crop" || op.kind === "init") return full;

  const layerId = (op.payload as { layerId?: string }).layerId;
  if (!layerId) return full;

  const lb = findLayer(before.layers, layerId);
  const la = findLayer(after.layers, layerId);
  const rb = lb ? layerInfluenceBounds(lb, canvas) : null;
  const ra = la ? layerInfluenceBounds(la, canvas) : null;
  let r = rb && ra ? union(rb, ra) : (rb ?? ra);
  if (!r) return full; // neither side has it → conservative

  // Clip-base coupling: a clipping layer's output depends on the nearest visible
  // non-clipping layer below it — a structural fact `layerInfluenceBounds` can't
  // see. Widen by the clip run this op can actually perturb (usually empty, so
  // an ordinary edit keeps the tight union). See `perturbedClipRun`.
  for (const l of perturbedClipRun(op, before, after)) r = union(r, layerInfluenceBounds(l, canvas));
  return r;
}

/** Top-level index of the layer that owns `layerId`: the top-level layer that
 *  either IS `layerId` or has it anywhere in its `children` subtree. -1 if the
 *  id is not present in the document. */
function topIndexOf(doc: PsdDoc, layerId: string): number {
  return doc.layers.findIndex((l) => l.id === layerId || isDescendant(l, layerId));
}

/**
 * The minimum TOP-LEVEL layer index an op affects — the checkpoint-invalidation
 * threshold for the below-checkpoint cache (`fold[0, A)` stays valid iff nothing
 * at or below A changed). `crop`/`init` → 0 (whole stack). Structural ops
 * (`reorder`/`remove_layer`/`add_layer`) and every other layer-scoped op resolve
 * the affected layer's top-level ancestor index in `before` and `after` and take
 * the smaller — 0 (conservative) when the id is absent from both sides.
 */
export function opActiveIndex(op: { kind: string; payload: Record<string, unknown> }, before: PsdDoc, after: PsdDoc): number {
  if (op.kind === "crop" || op.kind === "init") return 0;
  // add_layer names the new layer under `layer`; every other layer-scoped op
  // (structural or not) names it under `layerId`.
  const p = op.payload as { layerId?: string; layer?: { id?: string } };
  const id = op.kind === "add_layer" ? p.layer?.id : p.layerId;
  if (!id) return 0; // no target layer → conservative (invalidate from the base)
  const candidates = [topIndexOf(before, id), topIndexOf(after, id)].filter((i) => i >= 0);
  return candidates.length ? Math.min(...candidates) : 0;
}
