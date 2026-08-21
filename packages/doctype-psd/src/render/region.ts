import type { Layer } from "../model/types.js";

type Rect = [number, number, number, number]; // [top,left,bottom,right]

const union = (a: Rect, b: Rect): Rect =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const grow = (r: Rect, m: number): Rect => [r[0] - m, r[1] - m, r[2] + m, r[3] + m];
const shift = (r: Rect, dx: number, dy: number): Rect => [r[0] + dy, r[1] + dx, r[2] + dy, r[3] + dx];
const clamp = (r: Rect, w: number, h: number): Rect =>
  [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(h, r[2]), Math.min(w, r[3])];

/** Canvas rect a layer may write into, including layer-effect bleed. */
export function layerInfluenceBounds(layer: Layer, canvas: { width: number; height: number }): Rect {
  // Adjustment layers transform the backdrop across their whole extent.
  if (layer.type === "adjustment") {
    const m = layer.mask;
    const restrict = !!m && ((m.defaultColor === 0) !== m.inverted);
    const r: Rect = restrict
      ? [m!.bounds[0], m!.bounds[1], m!.bounds[2], m!.bounds[3]]
      : [0, 0, canvas.height, canvas.width];
    return clamp(r, canvas.width, canvas.height);
  }
  let r: Rect = layer.type === "group"
    ? (layer.children ?? []).reduce<Rect | null>((acc, c) => {
        const cb = layerInfluenceBounds(c, canvas);
        return acc ? union(acc, cb) : cb;
      }, null) ?? [...layer.bounds] as Rect
    : ([...layer.bounds] as Rect);

  if (layer.stroke) {
    const m = layer.stroke.position === "outside" ? layer.stroke.size
      : layer.stroke.position === "center" ? Math.ceil(layer.stroke.size / 2) : 0;
    if (m > 0) r = union(r, grow(layer.bounds as Rect, m));
  }
  if (layer.dropShadow) {
    const ds = layer.dropShadow;
    const rad = (ds.angle * Math.PI) / 180;
    const dx = Math.round(-ds.distance * Math.cos(rad));
    const dy = Math.round(ds.distance * Math.sin(rad));
    r = union(r, grow(shift(layer.bounds as Rect, dx, dy), ds.size + ds.choke));
  }
  return clamp(r, canvas.width, canvas.height);
}
