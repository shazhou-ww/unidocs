import type { StoreCtx } from "@unidocs/core";
import type { PsdDoc } from "../model/types.js";
import { resolveLayerPixels } from "../resolve.js";
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

/** Returns the layerId a `transform`+`flip` op will mutate existing pixels of,
 *  or undefined for any op that does not mutate a resident pixel buffer.
 *  `transform`+`flip` is the ONLY op that rewrites an existing layer's pixels
 *  (generative_fill ADDS a resident layer; set_props/reorder/remove/crop/
 *  adjust/mask_edit never touch existing pixel buffers), so it is the only op
 *  that needs its target faulted-in when the doc is lazy. */
function flipTargetLayerId(op: PsdOp): string | undefined {
  if (op.kind !== "transform") return undefined;
  const payload = op.payload as { layerId?: unknown; op?: { flip?: unknown } };
  if (!payload?.op?.flip) return undefined;
  return typeof payload.layerId === "string" ? payload.layerId : undefined;
}

export async function apply(
  operations: readonly PsdOp[],
  doc: PsdDoc,
  ctx?: StoreCtx,
): Promise<PsdDoc> {
  let cur = doc;
  for (const op of operations) {
    // Lazy-doc support: a flip mutates existing pixels, so its target layer's
    // PixelRef must be faulted-in first (when a store is available). Without a
    // store, geometry-ops' flip keeps its loud throw as the guard.
    const flipTarget = ctx?.store ? flipTargetLayerId(op) : undefined;
    if (flipTarget) cur = await resolveLayerPixels(cur, flipTarget, ctx!.store);
    cur = applyOne(cur, op);
  }
  return cur;
}
