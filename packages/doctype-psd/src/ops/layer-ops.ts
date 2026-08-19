import type { PsdDoc, Layer, BlendMode } from "../model/types.js";
import { findLayer, findParentList, removeById, insertAt, isDescendant } from "../model/tree.js";

const BLEND_MODES: BlendMode[] = [
  "normal","dissolve","darken","multiply","color-burn","linear-burn","lighten","screen",
  "color-dodge","linear-dodge","overlay","soft-light","hard-light","vivid-light","linear-light",
  "difference","exclusion","subtract","divide","hue","saturation","color","luminosity","pass-through",
];

export const SETTABLE_PROPS = ["name","opacity","blendMode","visible","locked","clipping"] as const;

function targetList(doc: PsdDoc, parentId: string | null): Layer[] {
  if (parentId === null) return doc.layers;
  const parent = findLayer(doc.layers, parentId);
  if (!parent) throw new Error(`parent not found: ${parentId}`);
  if (parent.type !== "group") throw new Error(`parent is not a group: ${parentId}`);
  parent.children ??= [];
  return parent.children;
}

export function addLayer(doc: PsdDoc, p: { layer: Layer; parentId: string | null; index?: number }): void {
  if (findLayer(doc.layers, p.layer.id)) throw new Error(`layer id already exists: ${p.layer.id}`);
  insertAt(targetList(doc, p.parentId), p.layer, p.index);
}

export function removeLayer(doc: PsdDoc, p: { layerId: string }): void {
  if (!removeById(doc.layers, p.layerId)) throw new Error(`layer not found: ${p.layerId}`);
}

export function reorder(doc: PsdDoc, p: { layerId: string; parentId: string | null; index?: number }): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  if (p.parentId !== null) {
    if (p.parentId === p.layerId || isDescendant(layer, p.parentId)) {
      throw new Error(`reorder would create a cycle: ${p.layerId} into ${p.parentId}`);
    }
  }
  removeById(doc.layers, p.layerId);
  insertAt(targetList(doc, p.parentId), layer, p.index);
}

export function setProps(
  doc: PsdDoc,
  p: { layerId: string; props: Record<string, unknown> },
): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  for (const [k, v] of Object.entries(p.props)) {
    if (!SETTABLE_PROPS.includes(k as any)) throw new Error(`immutable or unknown prop: ${k}`);
    if (k === "opacity" && (typeof v !== "number" || v < 0 || v > 1)) throw new Error(`opacity out of range: ${String(v)}`);
    if (k === "blendMode" && !BLEND_MODES.includes(v as BlendMode)) throw new Error(`invalid blendMode: ${String(v)}`);
    (layer as any)[k] = v;
  }
}
