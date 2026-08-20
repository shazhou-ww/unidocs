import type { PsdDoc, Layer } from "../model/types.js";
import { findLayer } from "../model/tree.js";
import { isRef } from "../render/pixel-source.js";

function shiftBounds(b: [number, number, number, number], dx: number, dy: number): [number, number, number, number] {
  return [b[0] + dy, b[1] + dx, b[2] + dy, b[3] + dx];
}

function shiftLayer(l: Layer, dx: number, dy: number): void {
  l.bounds = shiftBounds(l.bounds, dx, dy);
  if (l.mask) l.mask.bounds = shiftBounds(l.mask.bounds, dx, dy);
  if (l.children) for (const c of l.children) shiftLayer(c, dx, dy);
}

export function crop(doc: PsdDoc, p: { rect: [number, number, number, number] }): void {
  const [top, left, bottom, right] = p.rect;
  doc.canvas.width = right - left;
  doc.canvas.height = bottom - top;
  for (const l of doc.layers) shiftLayer(l, -left, -top);
}

export function transform(doc: PsdDoc, p: { layerId: string; op: Record<string, unknown> }): void {
  const layer = findLayer(doc.layers, p.layerId);
  if (!layer) throw new Error(`layer not found: ${p.layerId}`);
  if ("scale" in p.op || "rotate" in p.op) {
    throw new Error("transform scale/rotate not supported in MVP (needs deterministic resampler)");
  }
  const t = p.op.translate as [number, number] | undefined;
  if (t) shiftLayer(layer, t[0], t[1]);
  const flip = p.op.flip as "h" | "v" | undefined;
  // flipPixels needs resident Pixels; a PixelRef here must fail loudly
  // (consistent with save.ts) rather than silently no-op and produce a
  // wrong render.
  if (flip && layer.pixels) {
    if (isRef(layer.pixels)) {
      throw new Error("transform flip: pixels not resolved (PixelRef) — resolve before edit");
    }
    flipPixels(layer.pixels, flip);
  }
}

function flipPixels(px: { width: number; height: number; data: Uint8ClampedArray }, dir: "h" | "v"): void {
  const { width: w, height: h, data } = px;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = dir === "h" ? w - 1 - x : x;
      const sy = dir === "v" ? h - 1 - y : y;
      const s = (sy * w + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = data[s]; out[d+1] = data[s+1]; out[d+2] = data[s+2]; out[d+3] = data[s+3];
    }
  }
  data.set(out);
}
