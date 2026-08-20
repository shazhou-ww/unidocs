import type { PsdDoc, Mask } from "../model/types.js";
import { findLayer } from "../model/tree.js";

export function maskEdit(doc: PsdDoc, p: { layerId: string; mask: Mask | null }): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  layer.mask = p.mask;
}
