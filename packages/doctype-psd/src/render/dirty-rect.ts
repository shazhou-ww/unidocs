import type { PsdDoc, Layer } from "../model/types.js";
import { layerInfluenceBounds } from "./region.js";
import { findLayer } from "../model/tree.js";

type Rect = [number, number, number, number];

const union = (a: Rect, b: Rect): Rect =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

function hasClipping(layers: Layer[]): boolean {
  for (const l of layers) {
    if (l.clipping) return true;
    if (l.children && hasClipping(l.children)) return true;
  }
  return false;
}

const STRUCTURAL = new Set(["reorder", "remove_layer", "add_layer"]);

export function opDirtyRect(op: { kind: string; payload: Record<string, unknown> }, before: PsdDoc, after: PsdDoc): Rect {
  const canvas = after.canvas;
  const full: Rect = [0, 0, canvas.height, canvas.width];
  if (op.kind === "crop" || op.kind === "init") return full;

  // Clip-base coupling: a clipping layer's output depends on the nearest
  // non-clipping visible layer below it — a structural fact layerInfluenceBounds
  // can't see. If any clip run could be affected, fall back to full canvas.
  const clipPresent = hasClipping(before.layers) || hasClipping(after.layers);
  if (clipPresent) {
    if (STRUCTURAL.has(op.kind)) return full;
    if (op.kind === "set_props") {
      const props = (op.payload as { props?: Record<string, unknown> }).props ?? {};
      if ("visible" in props || "clipping" in props) return full;
    }
  }

  const layerId = (op.payload as { layerId?: string }).layerId;
  if (!layerId) return full;

  const lb = findLayer(before.layers, layerId);
  const la = findLayer(after.layers, layerId);
  const rb = lb ? layerInfluenceBounds(lb, canvas) : null;
  const ra = la ? layerInfluenceBounds(la, canvas) : null;
  if (rb && ra) return union(rb, ra);
  if (rb) return rb;
  if (ra) return ra;
  return full; // neither side has it → conservative
}
