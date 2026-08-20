/**
 * Fidelity harness — compare our renderer against the ground truth that
 * Photoshop bakes into every PSD: the "composite image data" (the flattened
 * image Photoshop itself displays). We load the layer tree, render it with our
 * own compositor, and diff the two. Any format we silently drop (a blend mode,
 * fillOpacity, an effect, an adjustment) shows up as a pixel-diff spike —
 * that's how a fidelity loss gets caught without eyeballing files one by one.
 */
import { readPsd } from "ag-psd";
import type { Pixels } from "../../src/model/types.js";
import { load } from "../../src/psd/load.js";
import { render } from "../../src/render/index.js";
import { installCanvasShim } from "../../src/psd/canvas-shim.js";

export interface FidelityResult {
  width: number;
  height: number;
  /** Mean absolute per-channel RGB error, 0..255. The headline number. */
  meanErr: number;
  /** Worst single-channel error, 0..255. */
  maxErr: number;
  /** Fraction of pixels whose worst channel differs by more than `tol`. */
  pctOff: number;
  /** Whether Photoshop's composite was present to compare against. */
  hasComposite: boolean;
}

/** Read the Photoshop composite (merged image) as RGBA, or null if absent. */
function readComposite(bytes: Uint8Array): Pixels | null {
  installCanvasShim();
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true, skipLayerImageData: true });
  const id = psd.imageData as { width: number; height: number; data: Uint8ClampedArray } | undefined;
  if (!id || !id.data || id.width === 0) return null;
  return { width: id.width, height: id.height, data: id.data };
}

/**
 * Diff our render of `bytes` against Photoshop's own composite. `tol` is the
 * per-channel threshold (0..255) for counting a pixel as "off" in `pctOff`.
 * `diffOut`, if given, receives a heatmap (red = large error) for eyeballing.
 */
export async function compareToComposite(
  bytes: Uint8Array,
  opts: { tol?: number; diffOut?: (px: Pixels) => void } = {},
): Promise<FidelityResult> {
  const tol = opts.tol ?? 12;
  const composite = readComposite(bytes);
  const doc = await load(bytes);
  const ours = await render(doc);

  if (!composite) {
    return { width: ours.width, height: ours.height, meanErr: 0, maxErr: 0, pctOff: 0, hasComposite: false };
  }
  const w = Math.min(composite.width, ours.width);
  const h = Math.min(composite.height, ours.height);
  const diff = opts.diffOut ? new Uint8ClampedArray(w * h * 4) : null;

  let sum = 0, max = 0, off = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = (y * composite.width + x) * 4;
      const oi = (y * ours.width + x) * 4;
      // Composite is opaque; flatten our (possibly transparent) pixel over white
      // so unrendered transparent areas are compared on equal footing.
      const oa = ours.data[oi + 3] / 255;
      let pxMax = 0;
      for (let c = 0; c < 3; c++) {
        const o = ours.data[oi + c] * oa + 255 * (1 - oa);
        const e = Math.abs(o - composite.data[ci + c]);
        sum += e;
        if (e > pxMax) pxMax = e;
      }
      if (pxMax > max) max = pxMax;
      if (pxMax > tol) off++;
      if (diff) {
        const di = (y * w + x) * 4;
        diff[di] = pxMax; diff[di + 1] = 0; diff[di + 2] = 0; diff[di + 3] = 255;
      }
    }
  }
  if (diff && opts.diffOut) opts.diffOut({ width: w, height: h, data: diff });
  return {
    width: w, height: h,
    meanErr: sum / (w * h * 3),
    maxErr: max,
    pctOff: off / (w * h),
    hasComposite: true,
  };
}
