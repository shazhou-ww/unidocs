import type { PsdDoc, Layer, Pixels } from "../model/types.js";
import { compositeOver } from "./blend.js";

/** Flatten a document to a single RGBA buffer (canvas-sized). Pure TS, no canvas/wasm. */
export function render(doc: PsdDoc): Pixels {
  const w = doc.canvas.width;
  const h = doc.canvas.height;
  const acc = new Uint8ClampedArray(w * h * 4);
  for (const l of doc.layers) applyLayer(acc, w, h, l);
  return { width: w, height: h, data: acc };
}

function applyLayer(acc: Uint8ClampedArray, w: number, h: number, layer: Layer): void {
  if (!layer.visible) return;

  if (layer.type === "group") {
    const sub = new Uint8ClampedArray(w * h * 4);
    for (const c of layer.children ?? []) applyLayer(sub, w, h, c);
    compositeBuffer(acc, w, h, sub, w, h, 0, 0, layer.opacity, layer.blendMode);
    return;
  }

  if (layer.type === "adjustment") {
    applyAdjustment(acc, layer.adjustType, layer.params ?? {});
    return;
  }

  if (layer.pixels) {
    const [top, left] = layer.bounds;
    compositeBuffer(acc, w, h, layer.pixels.data, layer.pixels.width, layer.pixels.height, left, top, layer.opacity, layer.blendMode);
  }
}

function compositeBuffer(
  acc: Uint8ClampedArray, cw: number, ch: number,
  src: Uint8ClampedArray, sw: number, sh: number,
  ox: number, oy: number, opacity: number, mode: string,
): void {
  for (let y = 0; y < sh; y++) {
    const cy = oy + y;
    if (cy < 0 || cy >= ch) continue;
    for (let x = 0; x < sw; x++) {
      const cx = ox + x;
      if (cx < 0 || cx >= cw) continue;
      const si = (y * sw + x) * 4;
      const sa = (src[si + 3] / 255) * opacity;
      if (sa === 0) continue;
      const di = (cy * cw + cx) * 4;
      const out = compositeOver(
        [acc[di] / 255, acc[di + 1] / 255, acc[di + 2] / 255, acc[di + 3] / 255],
        [src[si] / 255, src[si + 1] / 255, src[si + 2] / 255, sa],
        mode,
      );
      acc[di] = out[0] * 255;
      acc[di + 1] = out[1] * 255;
      acc[di + 2] = out[2] * 255;
      acc[di + 3] = out[3] * 255;
    }
  }
}

function applyAdjustment(acc: Uint8ClampedArray, adjustType: string | undefined, params: Record<string, unknown>): void {
  // MVP: brightness/contrast only. Unsupported adjustment types are a no-op.
  if (adjustType !== "brit") return;
  const brightness = Number(params.brightness ?? 0);
  const contrast = Number(params.contrast ?? 0);
  for (let i = 0; i < acc.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = acc[i + c] / 255;
      v = v + brightness;
      v = (v - 0.5) * (1 + contrast) + 0.5;
      acc[i + c] = v * 255;
    }
  }
}
