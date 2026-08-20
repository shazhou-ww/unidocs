import type { PsdDoc, Layer, Pixels, Mask } from "../model/types.js";
import { compositeOver } from "./blend.js";
import { findLayer } from "../model/tree.js";

/** Mask coverage at canvas pixel (cx,cy), 0..1. Value is channel 0 of the
 *  mask; outside the mask rect it is `defaultColor`. */
function maskCoverageAt(mask: Mask, cx: number, cy: number): number {
  const [mt, ml, mb, mr] = mask.bounds;
  let v: number;
  if (mask.pixels.width > 0 && cx >= ml && cx < mr && cy >= mt && cy < mb) {
    v = mask.pixels.data[((cy - mt) * mask.pixels.width + (cx - ml)) * 4];
  } else {
    v = mask.defaultColor;
  }
  if (mask.inverted) v = 255 - v;
  return v / 255;
}

/** Flatten a document to a single RGBA buffer (canvas-sized). Pure TS, no canvas/wasm. */
export function render(doc: PsdDoc): Pixels {
  const w = doc.canvas.width;
  const h = doc.canvas.height;
  const acc = new Uint8ClampedArray(w * h * 4);
  renderList(acc, w, h, doc.layers);
  return { width: w, height: h, data: acc };
}

/**
 * Render a sibling list bottom-to-top, honoring clipping masks: a layer with
 * `clipping` is confined to the alpha of the base layer directly below it
 * (the nearest non-clipping layer). A new non-clipping layer starts a new
 * clip base.
 */
function renderList(acc: Uint8ClampedArray, w: number, h: number, layers: Layer[]): void {
  let baseCoverage: Uint8ClampedArray | null = null;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer.visible) {
      if (!layer.clipping) baseCoverage = null;
      continue;
    }
    if (layer.clipping && baseCoverage) {
      applyLayer(acc, w, h, layer, baseCoverage);
    } else {
      applyLayer(acc, w, h, layer);
      // The clip base is only needed if a following sibling actually clips to
      // it. Computing it eagerly for every layer is very expensive — for a
      // group it re-renders the whole group into a fresh canvas buffer — so
      // derive it lazily only when the next visible layer is a clipping layer.
      const next = nextVisible(layers, i + 1);
      baseCoverage = layer.type !== "adjustment" && next?.clipping ? layerAlpha(w, h, layer) : null;
    }
  }
}

/** The next visible layer at or after index `from`, or null. */
function nextVisible(layers: Layer[], from: number): Layer | null {
  for (let i = from; i < layers.length; i++) if (layers[i].visible) return layers[i];
  return null;
}

/**
 * A single reusable full-composite framebuffer. We keep exactly ONE composite
 * alive: it is re-rendered only when the document changes and reused for every
 * region/layer preview of that version. A document is replaced (never mutated
 * in place) on each edit — applyOne structuredClones — so object identity is a
 * safe version key. Retained memory is one canvas buffer regardless of history
 * length or how many previews are requested.
 *
 * Note: this slot is module-scoped, so if one isolate serves several documents
 * concurrently they share the slot — always correct (it re-renders on identity
 * mismatch), at worst an extra render under interleaving.
 * TODO(perf): render into the existing buffer when the canvas size is unchanged
 * to avoid re-allocating; pool the group/adjustment/clip scratch buffers.
 */
let framebuffer: { doc: PsdDoc; px: Pixels } | null = null;
export function renderCached(doc: PsdDoc): Pixels {
  if (framebuffer && framebuffer.doc === doc) return framebuffer.px;
  const px = render(doc);
  framebuffer = { doc, px }; // replaces the previous composite → old buffer is freed
  return px;
}

/** Reuse the cached composite, then crop to a canvas rectangle [top,left,bottom,right]. */
export function renderRegion(doc: PsdDoc, rect: [number, number, number, number]): Pixels {
  const full = renderCached(doc);
  const t = Math.max(0, Math.floor(rect[0]));
  const l = Math.max(0, Math.floor(rect[1]));
  const b = Math.min(full.height, Math.ceil(rect[2]));
  const r = Math.min(full.width, Math.ceil(rect[3]));
  const w = Math.max(0, r - l), h = Math.max(0, b - t);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((t + y) * full.width + (l + x)) * 4, di = (y * w + x) * 4;
      data[di] = full.data[si]; data[di + 1] = full.data[si + 1];
      data[di + 2] = full.data[si + 2]; data[di + 3] = full.data[si + 3];
    }
  }
  return { width: w, height: h, data };
}

/**
 * Render a single layer cropped to its bounds. Raster/group layers are rendered
 * in isolation (transparent backdrop); adjustment/clip layers — which have no
 * standalone pixels — or `context:true` fall back to the composite cropped to
 * the layer's bounds.
 */
export function renderLayer(doc: PsdDoc, layerId: string, opts: { context?: boolean } = {}): Pixels {
  const layer = findLayer(doc.layers, layerId);
  if (!layer) throw new Error(`layer not found: ${layerId}`);
  const isolatable = (layer.type === "raster" || layer.type === "group") && !opts.context;
  const source: PsdDoc = isolatable ? { canvas: doc.canvas, layers: [layer] } : doc;
  return renderRegion(source, layer.bounds);
}

/** Nearest-neighbour downscale so the longer side is at most `maxSize`. No-op if already small. */
export function downscale(px: Pixels, maxSize: number): Pixels {
  const { width: w, height: h } = px;
  if (w <= maxSize && h <= maxSize) return px;
  const scale = Math.min(maxSize / w, maxSize / h);
  const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
  const data = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale)), sy = Math.min(h - 1, Math.floor(y / scale));
      const si = (sy * w + sx) * 4, di = (y * tw + x) * 4;
      data[di] = px.data[si]; data[di + 1] = px.data[si + 1];
      data[di + 2] = px.data[si + 2]; data[di + 3] = px.data[si + 3];
    }
  }
  return { width: tw, height: th, data };
}

function applyLayer(acc: Uint8ClampedArray, w: number, h: number, layer: Layer, clip?: Uint8ClampedArray): void {
  if (!layer.visible) return;

  if (layer.type === "group") {
    const sub = new Uint8ClampedArray(w * h * 4);
    renderList(sub, w, h, layer.children ?? []);
    compositeBuffer(acc, w, h, sub, w, h, 0, 0, layer.opacity, layer.blendMode, layer.mask ?? undefined, clip);
    return;
  }

  if (layer.type === "adjustment") {
    // Photoshop applies an adjustment to the backdrop, then composites the
    // result back using the layer's blend mode / opacity / mask. Copy the
    // backdrop, transform the copy, then composite it over the original.
    const adjusted = new Uint8ClampedArray(acc);
    if (applyAdjustment(adjusted, layer.adjustType, layer.params ?? {})) {
      compositeBuffer(acc, w, h, adjusted, w, h, 0, 0, layer.opacity, layer.blendMode, layer.mask ?? undefined, clip);
    }
    return;
  }

  if (layer.pixels) {
    const [top, left] = layer.bounds;
    // Drop Shadow renders BEHIND the fill (and is an effect, so it uses layer
    // opacity, not fillOpacity — visible even on a fill:0 layer).
    if (layer.dropShadow) dropShadowEffect(acc, w, h, layer, clip);
    // Fill contribution. `fillOpacity` scales ONLY the layer's own fill, never
    // its effects — a fill:0 layer shows only its stroke/overlay (the classic
    // "frame" technique: transparent glass with a visible border).
    // Color Overlay is folded into the fill composite (unchanged legacy path,
    // kept exact for verified renders); it is not attenuated by fillOpacity.
    if (layer.colorOverlay) {
      compositeBuffer(acc, w, h, layer.pixels.data, layer.pixels.width, layer.pixels.height, left, top, layer.opacity, layer.blendMode, layer.mask ?? undefined, clip, layer.colorOverlay);
    } else {
      const fill = layer.opacity * (layer.fillOpacity ?? 1);
      if (fill > 0) {
        compositeBuffer(acc, w, h, layer.pixels.data, layer.pixels.width, layer.pixels.height, left, top, fill, layer.blendMode, layer.mask ?? undefined, clip);
      }
    }
    if (layer.stroke) strokeEffect(acc, w, h, layer, clip);
  }
}

/**
 * Stroke effect: paint a solid-colour band of width `size` along the layer's
 * shape edge. Membership in the shape comes from the fill's alpha (≥50%). We
 * compute a chamfer distance transform to the opposite region, then a pixel is
 * in the band when its distance to that region is within `size`:
 *   inside  → shape pixels within `size` of the outside
 *   outside → outside pixels within `size` of the shape
 *   center  → within `size/2` on whichever side
 * Stroke is a layer effect, so it uses layer.opacity (not fillOpacity).
 */
function strokeEffect(acc: Uint8ClampedArray, cw: number, ch: number, layer: Layer, clip?: Uint8ClampedArray): void {
  const px = layer.pixels!;
  const st = layer.stroke!;
  const { width: sw, height: sh, data } = px;
  const [top, left] = layer.bounds;
  const solid = (i: number) => data[i * 4 + 3] >= 128;
  const CH_ORTH = 3; // chamfer weights (3,4) ≈ Euclidean ×3
  // A shape that fills its whole pixel buffer has no transparent margin inside
  // it — the buffer boundary IS the shape edge — so for the inside stroke,
  // out-of-bounds counts as "outside" (a distance source). For the outside
  // stroke, out-of-bounds is not part of the shape.
  const inside = st.position !== "outside" ? chamferDist(sw, sh, (i) => !solid(i), true) : null;  // dist from shape → outside
  const outside = st.position !== "inside" ? chamferDist(sw, sh, (i) => solid(i), false) : null;  // dist from outside → shape
  const band = st.position === "center" ? Math.max(1, Math.round(st.size / 2)) * CH_ORTH : st.size * CH_ORTH;
  const sr = st.color.r / 255, sg = st.color.g / 255, sb = st.color.b / 255;
  const base = layer.opacity * st.opacity;
  for (let y = 0; y < sh; y++) {
    const cy = top + y;
    if (cy < 0 || cy >= ch) continue;
    for (let x = 0; x < sw; x++) {
      const cx = left + x;
      if (cx < 0 || cx >= cw) continue;
      const i = y * sw + x;
      const on = solid(i);
      let hit = false;
      if (st.position === "inside") hit = on && inside![i] <= band;
      else if (st.position === "outside") hit = !on && outside![i] <= band;
      else hit = on ? inside![i] <= band : outside![i] <= band;
      if (!hit) continue;
      let sa = base;
      if (layer.mask) sa *= maskCoverageAt(layer.mask, cx, cy);
      if (clip) sa *= clip[cy * cw + cx] / 255;
      if (sa === 0) continue;
      const di = (cy * cw + cx) * 4;
      const out = compositeOver(
        [acc[di] / 255, acc[di + 1] / 255, acc[di + 2] / 255, acc[di + 3] / 255],
        [sr, sg, sb, sa],
        st.blendMode,
      );
      acc[di] = out[0] * 255;
      acc[di + 1] = out[1] * 255;
      acc[di + 2] = out[2] * 255;
      acc[di + 3] = out[3] * 255;
    }
  }
}

/**
 * Drop Shadow effect: a coloured copy of the layer's shape, offset by
 * `distance` at `angle`° (Photoshop light angle; shadow falls opposite the
 * light) and optionally blurred by `size`, composited behind the layer. The
 * layer's own fill (drawn afterwards) conceals the overlapping part, matching
 * Photoshop's default "layer knocks out drop shadow".
 */
function dropShadowEffect(acc: Uint8ClampedArray, cw: number, ch: number, layer: Layer, clip?: Uint8ClampedArray): void {
  const ds = layer.dropShadow!;
  const px = layer.pixels!;
  const { width: sw, height: sh, data } = px;
  const [top, left] = layer.bounds;
  // Offset. Photoshop angle is CCW from east with y-up; screen y is down.
  const rad = (ds.angle * Math.PI) / 180;
  const dx = Math.round(-ds.distance * Math.cos(rad));
  const dy = Math.round(ds.distance * Math.sin(rad));
  const sr = ds.color.r / 255, sg = ds.color.g / 255, sb = ds.color.b / 255;
  const base = layer.opacity * ds.opacity;

  // Composite one shadow sample (canvas coords, coverage 0..1) behind acc.
  const put = (tx: number, ty: number, a: number): void => {
    if (a <= 0 || tx < 0 || tx >= cw || ty < 0 || ty >= ch) return;
    let sa = a * base;
    if (clip) sa *= clip[ty * cw + tx] / 255;
    if (sa <= 0) return;
    const di = (ty * cw + tx) * 4;
    const out = compositeOver(
      [acc[di] / 255, acc[di + 1] / 255, acc[di + 2] / 255, acc[di + 3] / 255],
      [sr, sg, sb, sa],
      ds.blendMode,
    );
    acc[di] = out[0] * 255;
    acc[di + 1] = out[1] * 255;
    acc[di + 2] = out[2] * 255;
    acc[di + 3] = out[3] * 255;
  };

  // Hard-edged (size 0): no buffer at all — read each layer pixel's alpha and
  // composite the coloured shadow straight to the offset position.
  if (ds.size <= 0) {
    for (let y = 0; y < sh; y++) {
      const cy = top + y;
      for (let x = 0; x < sw; x++) {
        let a = data[(y * sw + x) * 4 + 3] / 255;
        if (a <= 0) continue;
        const cx = left + x;
        if (layer.mask && cx >= 0 && cx < cw && cy >= 0 && cy < ch) a *= maskCoverageAt(layer.mask, cx, cy);
        put(cx + dx, cy + dy, a);
      }
    }
    return;
  }

  // Blurred: gather the shape alpha into a buffer the size of the layer bounds
  // plus a blur margin (NOT the whole canvas), blur it there, then composite at
  // the offset. Peak memory is proportional to the layer, not the document.
  const m = ds.size;
  const bw = sw + 2 * m, bh = sh + 2 * m;
  const alpha = new Float32Array(bw * bh);
  for (let y = 0; y < sh; y++) {
    const cy = top + y;
    for (let x = 0; x < sw; x++) {
      let a = data[(y * sw + x) * 4 + 3] / 255;
      if (a <= 0) continue;
      const cx = left + x;
      if (layer.mask && cx >= 0 && cx < cw && cy >= 0 && cy < ch) a *= maskCoverageAt(layer.mask, cx, cy);
      alpha[(y + m) * bw + (x + m)] = a;
    }
  }
  const blurred = boxBlurAlpha(alpha, bw, bh, m);
  for (let ly = 0; ly < bh; ly++) {
    for (let lx = 0; lx < bw; lx++) {
      const a = blurred[ly * bw + lx];
      if (a <= 0) continue;
      put(left - m + lx + dx, top - m + ly + dy, a);
    }
  }
}

/** Separable box blur of a single-channel (0..1) buffer, radius `r` px. Two
 *  passes approximate a gaussian well enough for shadow/glow softening. */
function boxBlurAlpha(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const rad = Math.max(1, Math.round(r));
  let a = src;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h);
    const win = 2 * rad + 1;
    // horizontal
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = -rad; x <= rad; x++) sum += a[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = sum / win;
        const add = a[y * w + Math.min(w - 1, x + rad + 1)];
        const rem = a[y * w + Math.max(0, x - rad)];
        sum += add - rem;
      }
    }
    const out = new Float32Array(w * h);
    // vertical
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -rad; y <= rad; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / win;
        const add = tmp[Math.min(h - 1, y + rad + 1) * w + x];
        const rem = tmp[Math.max(0, y - rad) * w + x];
        sum += add - rem;
      }
    }
    a = out;
  }
  return a;
}

/** 3-4 chamfer distance transform: for each pixel, the distance (in ×3 units)
 *  to the nearest pixel where `isZero` is true. Two passes, O(w*h). */
function chamferDist(w: number, h: number, isZero: (i: number) => boolean, oobIsZero: boolean): Int32Array {
  const INF = 1 << 29;
  const OOB = oobIsZero ? 0 : INF;
  const d = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = isZero(i) ? 0 : INF;
  const at = (x: number, y: number) => (x >= 0 && x < w && y >= 0 && y < h ? d[y * w + x] : OOB);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
  return d;
}

/** Per-pixel canvas alpha (0..255) of a single layer, used as a clipping base
 *  (the base's own transparency + mask; opacity does not affect clip shape). */
function layerAlpha(w: number, h: number, layer: Layer): Uint8ClampedArray | null {
  const cov = new Uint8ClampedArray(w * h);
  if (layer.type === "group") {
    const sub = new Uint8ClampedArray(w * h * 4);
    renderList(sub, w, h, layer.children ?? []);
    for (let i = 0; i < w * h; i++) {
      let a = sub[i * 4 + 3] / 255;
      if (layer.mask) a *= maskCoverageAt(layer.mask, i % w, Math.floor(i / w));
      cov[i] = a * 255;
    }
    return cov;
  }
  if (layer.pixels) {
    const [top, left] = layer.bounds;
    const { width: sw, height: sh, data } = layer.pixels;
    for (let y = 0; y < sh; y++) {
      const cy = top + y;
      if (cy < 0 || cy >= h) continue;
      for (let x = 0; x < sw; x++) {
        const cx = left + x;
        if (cx < 0 || cx >= w) continue;
        let a = data[(y * sw + x) * 4 + 3] / 255;
        if (layer.mask) a *= maskCoverageAt(layer.mask, cx, cy);
        cov[cy * w + cx] = a * 255;
      }
    }
    return cov;
  }
  return null; // adjustment / empty → cannot be a clip base
}

function compositeBuffer(
  acc: Uint8ClampedArray, cw: number, ch: number,
  src: Uint8ClampedArray, sw: number, sh: number,
  ox: number, oy: number, opacity: number, mode: string,
  mask?: Mask, clip?: Uint8ClampedArray,
  colorOverlay?: { r: number; g: number; b: number; opacity: number },
): void {
  const oa = colorOverlay ? colorOverlay.opacity : 0;
  for (let y = 0; y < sh; y++) {
    const cy = oy + y;
    if (cy < 0 || cy >= ch) continue;
    for (let x = 0; x < sw; x++) {
      const cx = ox + x;
      if (cx < 0 || cx >= cw) continue;
      const si = (y * sw + x) * 4;
      let sa = (src[si + 3] / 255) * opacity;
      if (mask) sa *= maskCoverageAt(mask, cx, cy);
      if (clip) sa *= clip[cy * cw + cx] / 255;
      if (sa === 0) continue;
      const di = (cy * cw + cx) * 4;
      // Color Overlay effect: replace the layer's colour within its alpha
      // (normal-blend approximation of the effect blend mode).
      let sr = src[si] / 255, sg = src[si + 1] / 255, sb = src[si + 2] / 255;
      if (colorOverlay) {
        sr = sr * (1 - oa) + (colorOverlay.r / 255) * oa;
        sg = sg * (1 - oa) + (colorOverlay.g / 255) * oa;
        sb = sb * (1 - oa) + (colorOverlay.b / 255) * oa;
      }
      const out = compositeOver(
        [acc[di] / 255, acc[di + 1] / 255, acc[di + 2] / 255, acc[di + 3] / 255],
        [sr, sg, sb, sa],
        mode,
      );
      acc[di] = out[0] * 255;
      acc[di + 1] = out[1] * 255;
      acc[di + 2] = out[2] * 255;
      acc[di + 3] = out[3] * 255;
    }
  }
}

/** Apply an adjustment to `acc` in place. Returns true if it changed pixels
 *  (unsupported adjustment types are a no-op and return false). */
function applyAdjustment(acc: Uint8ClampedArray, adjustType: string | undefined, params: Record<string, unknown>): boolean {
  switch (adjustType) {
    case "brit": return brightnessContrast(acc, params);
    case "blwh": return blackAndWhite(acc, params);
    case "hue2": return hueSaturation(acc, params);
    default: return false;
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

function brightnessContrast(acc: Uint8ClampedArray, params: Record<string, unknown>): boolean {
  const brightness = num(params.brightness, 0);
  const contrast = num(params.contrast, 0);
  for (let i = 0; i < acc.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = acc[i + c] / 255;
      v = v + brightness;
      v = (v - 0.5) * (1 + contrast) + 0.5;
      acc[i + c] = v * 255;
    }
  }
  return true;
}

/**
 * Black & White adjustment. Decomposes each pixel into a neutral part (min)
 * plus a chroma part weighted by the pixel's hue; the six weights (reds…
 * magentas, as percentages) are interpolated around the hue wheel. Matches
 * Photoshop's defaults (a pure primary at 40% → 0.4 gray).
 */
function blackAndWhite(acc: Uint8ClampedArray, p: Record<string, unknown>): boolean {
  const w = [
    num(p.reds, 40), num(p.yellows, 60), num(p.greens, 40),
    num(p.cyans, 60), num(p.blues, 20), num(p.magentas, 80),
  ].map((v) => v / 100);
  const tint = p.useTint ? (p.tintColor as { r: number; g: number; b: number } | undefined) : undefined;
  for (let i = 0; i < acc.length; i += 4) {
    const r = acc[i] / 255, g = acc[i + 1] / 255, b = acc[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
    let gray: number;
    if (chroma === 0) {
      gray = min;
    } else {
      let h: number;
      if (max === r) h = ((g - b) / chroma) % 6;
      else if (max === g) h = (b - r) / chroma + 2;
      else h = (r - g) / chroma + 4;
      if (h < 0) h += 6;
      const i0 = Math.floor(h) % 6, f = h - Math.floor(h);
      const wv = w[i0] * (1 - f) + w[(i0 + 1) % 6] * f;
      gray = min + chroma * wv;
    }
    gray = clamp01(gray);
    if (tint) {
      acc[i] = clamp01(gray * (tint.r / 255)) * 255;
      acc[i + 1] = clamp01(gray * (tint.g / 255)) * 255;
      acc[i + 2] = clamp01(gray * (tint.b / 255)) * 255;
    } else {
      acc[i] = acc[i + 1] = acc[i + 2] = gray * 255;
    }
  }
  return true;
}

/** Hue/Saturation adjustment (master channel + colorize). */
function hueSaturation(acc: Uint8ClampedArray, p: Record<string, unknown>): boolean {
  const colorize = !!p.colorize;
  const m = (p.master ?? p) as Record<string, unknown>;
  const hue = num(m.hue, 0);          // colorize: 0..360 absolute; else -180..180
  const sat = num(m.saturation, colorize ? 25 : 0); // colorize: 0..100; else -100..100
  const light = num(m.lightness, 0);  // -100..100
  for (let i = 0; i < acc.length; i += 4) {
    let [H, S, L] = rgbToHsl(acc[i] / 255, acc[i + 1] / 255, acc[i + 2] / 255);
    if (colorize) {
      H = (((hue % 360) + 360) % 360) / 360;
      S = clamp01(sat / 100);
    } else {
      H = H + hue / 360; H = H - Math.floor(H);
      S = clamp01(sat >= 0 ? S + (1 - S) * (sat / 100) : S * (1 + sat / 100));
    }
    L = clamp01(light > 0 ? L + (1 - L) * (light / 100) : light < 0 ? L * (1 + light / 100) : L);
    const [r, g, b] = hslToRgb(H, S, L);
    acc[i] = r * 255; acc[i + 1] = g * 255; acc[i + 2] = b * 255;
  }
  return true;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6; if (h < 0) h += 1;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const pp = 2 * l - q;
  const hk = (t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return pp + (q - pp) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return pp + (q - pp) * (2 / 3 - t) * 6;
    return pp;
  };
  return [hk(h + 1 / 3), hk(h), hk(h - 1 / 3)];
}
