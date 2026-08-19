import type { PsdDoc } from "../model/types.js";
import { findLayer } from "../model/tree.js";

export function adjust(doc: PsdDoc, p: { layerId: string; params: Record<string, unknown> }): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  if (layer.type !== "adjustment") throw new Error(`not an adjustment layer: ${p.layerId}`);
  layer.params = { ...(layer.params ?? {}), ...p.params };
}
