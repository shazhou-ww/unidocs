import type { PsdDoc } from "../model/types.js";
import { addLayer, removeLayer, reorder, setProps } from "./layer-ops.js";
import { crop, transform } from "./geometry-ops.js";
import { adjust } from "./adjust-ops.js";
import { maskEdit } from "./mask-ops.js";
import { generativeFill } from "./generative-ops.js";

export type PsdOp = { kind: string; payload: Record<string, unknown> };

const HANDLERS: Record<string, (doc: PsdDoc, payload: any) => void> = {
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
