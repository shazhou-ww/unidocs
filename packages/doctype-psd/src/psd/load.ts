import { readPsd, type Layer as AgLayer } from "ag-psd";
import type { PsdDoc, Layer, BlendMode } from "../model/types.js";
import { installCanvasShim } from "./canvas-shim.js";

function mapLayer(a: AgLayer, i: number): Layer {
  const isGroup = Array.isArray(a.children);
  const px = a.imageData
    ? { width: a.imageData.width, height: a.imageData.height, data: a.imageData.data as Uint8ClampedArray }
    : undefined;
  return {
    id: `l${i}_${a.name ?? "layer"}`.replace(/\s+/g, "_"),
    type: isGroup ? "group" : "raster",
    name: a.name ?? "",
    bounds: [a.top ?? 0, a.left ?? 0, a.bottom ?? 0, a.right ?? 0],
    opacity: a.opacity ?? 1,
    blendMode: (a.blendMode ?? "normal") as BlendMode,
    visible: !a.hidden,
    locked: false,
    clipping: !!a.clipping,
    ...(px ? { pixels: px } : {}),
    ...(isGroup ? { children: (a.children ?? []).map(mapLayer) } : {}),
  };
}

export async function load(data: Uint8Array): Promise<PsdDoc> {
  installCanvasShim();
  const psd = readPsd(data, {
    useImageData: true,
    skipThumbnail: true,
    logMissingFeatures: true,
    throwForMissingFeatures: false,
  });
  if (psd.bitsPerChannel && psd.bitsPerChannel !== 8) {
    throw new Error(`unsupported bit depth: ${psd.bitsPerChannel} (only 8-bit RGB)`);
  }
  if (psd.colorMode !== undefined && psd.colorMode !== 3 /* RGB */) {
    throw new Error(`unsupported color mode: ${psd.colorMode} (only RGB)`);
  }
  return {
    canvas: { width: psd.width, height: psd.height, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: (psd.children ?? []).map(mapLayer),
  };
}
