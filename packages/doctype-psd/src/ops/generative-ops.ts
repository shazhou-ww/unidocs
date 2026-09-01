import type { PsdDoc, Layer } from "../model/types.js";
import { addLayer } from "./layer-ops.js";

export function generativeFill(
  doc: PsdDoc,
  p: { layer: Layer; parentId: string | null; index?: number; provenance: { model: string; seed?: number; prompt: string } },
): void {
  if (!p.layer.pixels) throw new Error("generative_fill: layer.pixels missing — result must be pre-resolved");
  const layer: Layer = { ...p.layer, provenance: p.provenance };
  addLayer(doc, { layer, parentId: p.parentId, index: p.index });
}
