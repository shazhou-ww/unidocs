import { writePsd, type Psd, type Layer as AgLayer } from "ag-psd";
import type { PsdDoc, Layer } from "../model/types.js";
import { installCanvasShim } from "./canvas-shim.js";

function mapLayer(l: Layer): AgLayer {
  const [top, left, bottom, right] = l.bounds;
  const out: AgLayer = {
    name: l.name,
    opacity: l.opacity,
    blendMode: l.blendMode as any,
    hidden: !l.visible,
    clipping: l.clipping,
    left, top, right, bottom,
  };
  if (l.children) out.children = l.children.map(mapLayer);
  else if (l.pixels) out.imageData = { width: l.pixels.width, height: l.pixels.height, data: l.pixels.data } as any;
  return out;
}

export async function save(doc: PsdDoc): Promise<Uint8Array> {
  installCanvasShim();
  const composite = {
    width: doc.canvas.width,
    height: doc.canvas.height,
    data: new Uint8ClampedArray(doc.canvas.width * doc.canvas.height * 4),
  };
  const psd: Psd = {
    width: doc.canvas.width,
    height: doc.canvas.height,
    children: doc.layers.map(mapLayer),
    imageData: composite as any,
  };
  const buffer = writePsd(psd, { generateThumbnail: false, psb: false });
  return new Uint8Array(buffer);
}
