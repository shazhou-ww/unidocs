import type { PsdDoc, Layer, BlendMode } from "../model/types.js";
import { findLayer, findParentList, removeById, insertAt, isDescendant } from "../model/tree.js";

const BLEND_MODES: BlendMode[] = [
  "normal","dissolve","darken","multiply","color-burn","linear-burn","lighten","screen",
  "color-dodge","linear-dodge","overlay","soft-light","hard-light","vivid-light","linear-light",
  "difference","exclusion","subtract","divide","hue","saturation","color","luminosity","pass-through",
];

export const SETTABLE_PROPS = ["name","opacity","blendMode","visible","locked","clipping"] as const;

const LAYER_TYPES = ["raster","adjustment","fill","text","smartObject","group"];

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Reject structurally invalid layers so a bad add_layer fails cleanly in
 * apply() (delta never commits) instead of corrupting the document and
 * bricking every later save/render/query. Also fills soft defaults.
 */
export function validateAndNormalizeLayer(layer: Layer): void {
  if (!layer || typeof layer !== "object") throw new Error("layer must be an object");
  if (typeof layer.id !== "string" || !layer.id) throw new Error("layer.id must be a non-empty string");
  if (!LAYER_TYPES.includes(layer.type)) {
    throw new Error(`layer.type must be one of ${LAYER_TYPES.join("|")} (got ${JSON.stringify(layer.type)})`);
  }
  const b = layer.bounds as unknown;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(isFiniteNum)) {
    throw new Error(`layer.bounds must be [top,left,bottom,right] numbers (got ${JSON.stringify(b)})`);
  }
  // Soft defaults for model-required fields the caller may omit.
  layer.opacity ??= 1;
  layer.visible ??= true;
  layer.blendMode ??= "normal";
  if (!isFiniteNum(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
    throw new Error(`layer.opacity must be a number 0..1 (got ${String(layer.opacity)})`);
  }
  if (typeof layer.visible !== "boolean") throw new Error("layer.visible must be a boolean");
  if (!BLEND_MODES.includes(layer.blendMode)) throw new Error(`invalid blendMode: ${String(layer.blendMode)}`);

  if (layer.type === "raster" && !layer.pixels) {
    throw new Error("raster layer requires pixels (a solid-color fill must be supplied as raster pixels)");
  }
  if (layer.type === "adjustment" && (typeof layer.adjustType !== "string" || !layer.adjustType)) {
    throw new Error("adjustment layer requires an adjustType string (e.g. 'brit'); note the field is adjustType, not adjustmentType");
  }
  if (layer.pixels) {
    const p = layer.pixels as { width?: unknown; height?: unknown; data?: unknown };
    if (!isFiniteNum(p.width) || !isFiniteNum(p.height) || !p.data || typeof (p.data as { length?: unknown }).length !== "number") {
      throw new Error("layer.pixels must have numeric width/height and a data buffer");
    }
  }
  if (layer.type === "group" && layer.children) {
    for (const c of layer.children) validateAndNormalizeLayer(c);
  }
}

function targetList(doc: PsdDoc, parentId: string | null): Layer[] {
  if (parentId === null) return doc.layers;
  const parent = findLayer(doc.layers, parentId);
  if (!parent) throw new Error(`parent not found: ${parentId}`);
  if (parent.type !== "group") throw new Error(`parent is not a group: ${parentId}`);
  parent.children ??= [];
  return parent.children;
}

export function addLayer(doc: PsdDoc, p: { layer: Layer; parentId: string | null; index?: number }): void {
  validateAndNormalizeLayer(p.layer);
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
