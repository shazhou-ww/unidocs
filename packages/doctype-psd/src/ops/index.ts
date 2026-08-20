import type { PsdDoc } from "../model/types.js";
import { addLayer, removeLayer, reorder, setProps } from "./layer-ops.js";
import { crop, transform } from "./geometry-ops.js";
import { adjust } from "./adjust-ops.js";
import { maskEdit } from "./mask-ops.js";
import { generativeFill } from "./generative-ops.js";

export type PsdOp = { kind: string; payload: Record<string, unknown> };

/** Replaces the document wholesale with the supplied IR payload
 *  (`{canvas, layers}`), rather than merging into the existing doc.
 *  Used to restore a trusted snapshot (e.g. from `deserialize`), so no
 *  per-layer validation is performed — payload layers may carry lazy
 *  PixelRef pixels with no `data`. */
function init(doc: PsdDoc, payload: any): void {
  const canvas = payload?.canvas;
  if (typeof canvas !== "object" || canvas === null) {
    throw new Error("init: malformed payload — canvas must be a non-null object");
  }
  if (typeof canvas.width !== "number" || !Number.isFinite(canvas.width)) {
    throw new Error("init: malformed payload — canvas.width must be a finite number");
  }
  if (typeof canvas.height !== "number" || !Number.isFinite(canvas.height)) {
    throw new Error("init: malformed payload — canvas.height must be a finite number");
  }
  if (payload.layers !== undefined && !Array.isArray(payload.layers)) {
    throw new Error("init: malformed payload — layers must be an array when present");
  }
  doc.canvas = payload.canvas;
  doc.layers = payload.layers ?? [];
}

const HANDLERS: Record<string, (doc: PsdDoc, payload: any) => void> = {
  init,
  add_layer: addLayer,
  remove_layer: removeLayer,
  reorder,
  set_props: setProps,
  crop,
  transform,
  adjust,
  mask_edit: maskEdit,
  generative_fill: generativeFill,
};

export function applyOne(doc: PsdDoc, op: PsdOp): PsdDoc {
  const handler = HANDLERS[op.kind];
  if (!handler) throw new Error(`unknown op: ${op.kind}`);
  const next = structuredClone(doc);
  handler(next, op.payload);
  return next;
}

export async function apply(operations: readonly PsdOp[], doc: PsdDoc): Promise<PsdDoc> {
  let cur = doc;
  for (const op of operations) cur = applyOne(cur, op);
  return cur;
}
