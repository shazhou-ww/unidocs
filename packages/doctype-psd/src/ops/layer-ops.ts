import type { PsdDoc, Layer, BlendMode } from "../model/types.js";
import { findLayer, findParentList, removeById, insertAt, isDescendant } from "../model/tree.js";

const BLEND_MODES: BlendMode[] = [
  "normal","dissolve","darken","multiply","color-burn","linear-burn","lighten","screen",
  "color-dodge","linear-dodge","overlay","soft-light","hard-light","vivid-light","linear-light",
  "difference","exclusion","subtract","divide","hue","saturation","color","luminosity","pass-through",
];

export const SETTABLE_PROPS = [
  "name", "opacity", "blendMode", "visible", "locked", "clipping",
  "fillOpacity", "stroke", "colorOverlay", "dropShadow",
] as const;

/** Effects that accept `null` to mean "remove this effect". */
const EFFECT_PROPS = new Set(["stroke", "colorOverlay", "dropShadow"]);
const STROKE_POSITIONS = ["inside", "outside", "center"];

const LAYER_TYPES = ["raster","adjustment","fill","text","smartObject","group"];

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

const isUnit = (n: unknown): n is number => isFiniteNum(n) && n >= 0 && n <= 1;
const isByte = (n: unknown): n is number => isFiniteNum(n) && n >= 0 && n <= 255;
const isRgb = (v: unknown): boolean => {
  const c = v as { r?: unknown; g?: unknown; b?: unknown } | null;
  return !!c && typeof c === "object" && isByte(c.r) && isByte(c.g) && isByte(c.b);
};

function validateStroke(v: unknown): void {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== "object") throw new Error("stroke must be an object or null");
  if (!isRgb(s.color)) throw new Error("stroke.color must be {r,g,b} in 0..255");
  if (!isUnit(s.opacity)) throw new Error(`stroke.opacity out of range 0..1: ${String(s.opacity)}`);
  if (!isFiniteNum(s.size) || s.size < 0) throw new Error(`stroke.size must be >= 0: ${String(s.size)}`);
  if (!STROKE_POSITIONS.includes(s.position as string)) {
    throw new Error(`invalid stroke.position: ${String(s.position)} (inside|outside|center)`);
  }
  if (!BLEND_MODES.includes(s.blendMode as BlendMode)) {
    throw new Error(`invalid stroke.blendMode: ${String(s.blendMode)}`);
  }
}

function validateColorOverlay(v: unknown): void {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c !== "object") throw new Error("colorOverlay must be an object or null");
  if (!isRgb(c)) throw new Error("colorOverlay must carry {r,g,b} in 0..255");
  // 0..1 blend factor — see render/composite.ts, which computes
  // `sr * (1 - oa) + (color.r / 255) * oa`.
  if (!isUnit(c.opacity)) throw new Error(`colorOverlay.opacity out of range 0..1: ${String(c.opacity)}`);
}

function validateDropShadow(v: unknown): void {
  const d = v as Record<string, unknown> | null;
  if (!d || typeof d !== "object") throw new Error("dropShadow must be an object or null");
  if (!isRgb(d.color)) throw new Error("dropShadow.color must be {r,g,b} in 0..255");
  if (!isUnit(d.opacity)) throw new Error(`dropShadow.opacity out of range 0..1: ${String(d.opacity)}`);
  if (!BLEND_MODES.includes(d.blendMode as BlendMode)) {
    throw new Error(`invalid dropShadow.blendMode: ${String(d.blendMode)}`);
  }
  for (const k of ["angle", "distance", "size", "choke"] as const) {
    if (!isFiniteNum(d[k])) throw new Error(`dropShadow.${k} must be a finite number`);
  }
  if ((d.size as number) < 0 || (d.choke as number) < 0) {
    throw new Error("dropShadow.size and dropShadow.choke must be >= 0");
  }
}

/**
 * Reject structurally invalid layers so a bad add_layer fails cleanly in
 * apply() (delta never commits) instead of corrupting the document and
 * bricking every later save/render/query. Also fills soft defaults.
 */
/**
 * Validates `layer` and returns a NORMALIZED COPY with the omitted
 * model-required fields filled in.
 *
 * The defaults deliberately land on a copy rather than on `layer` itself: on
 * the server the op payload comes out of the SValue decoder, which freezes
 * every decoded object (`svalue-codec/src/svalue.ts:386`), so writing them in
 * place threw `Cannot add property opacity, object is not extensible` and made
 * every single `add_layer` fail. Unit tests never caught it because they build
 * plain object literals — see tests/apply.test.ts.
 */
export function validateAndNormalizeLayer(layer: Layer): Layer {
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
  const out: Layer = {
    ...layer,
    opacity: layer.opacity ?? 1,
    visible: layer.visible ?? true,
    blendMode: layer.blendMode ?? "normal",
  };
  if (!isFiniteNum(out.opacity) || out.opacity < 0 || out.opacity > 1) {
    throw new Error(`layer.opacity must be a number 0..1 (got ${String(out.opacity)})`);
  }
  if (typeof out.visible !== "boolean") throw new Error("layer.visible must be a boolean");
  if (!BLEND_MODES.includes(out.blendMode)) throw new Error(`invalid blendMode: ${String(out.blendMode)}`);

  if (out.type === "raster" && !out.pixels) {
    throw new Error("raster layer requires pixels (a solid-color fill must be supplied as raster pixels)");
  }
  if (out.type === "adjustment" && (typeof out.adjustType !== "string" || !out.adjustType)) {
    throw new Error("adjustment layer requires an adjustType string (e.g. 'brit'); note the field is adjustType, not adjustmentType");
  }
  if (out.pixels) {
    const p = out.pixels as { width?: unknown; height?: unknown; data?: unknown };
    if (!isFiniteNum(p.width) || !isFiniteNum(p.height) || !p.data || typeof (p.data as { length?: unknown }).length !== "number") {
      throw new Error("layer.pixels must have numeric width/height and a data buffer");
    }
  }
  if (out.type === "group" && out.children) {
    out.children = out.children.map(validateAndNormalizeLayer);
  }
  return out;
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
  const layer = validateAndNormalizeLayer(p.layer);
  if (findLayer(doc.layers, layer.id)) throw new Error(`layer id already exists: ${layer.id}`);
  insertAt(targetList(doc, p.parentId), layer, p.index);
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
    // Effects are removable: null/undefined deletes the key entirely, so a
    // layer with no stroke is `stroke === undefined` (what the renderer and
    // layerInfluenceBounds both test for), never `stroke === null`.
    if (EFFECT_PROPS.has(k) && (v === null || v === undefined)) {
      delete (layer as any)[k];
      continue;
    }
    if (k === "opacity" && !isUnit(v)) throw new Error(`opacity out of range: ${String(v)}`);
    if (k === "fillOpacity" && !isUnit(v)) throw new Error(`fillOpacity out of range: ${String(v)}`);
    if (k === "blendMode" && !BLEND_MODES.includes(v as BlendMode)) throw new Error(`invalid blendMode: ${String(v)}`);
    if (k === "stroke") validateStroke(v);
    if (k === "colorOverlay") validateColorOverlay(v);
    if (k === "dropShadow") validateDropShadow(v);
    (layer as any)[k] = v;
  }
}
