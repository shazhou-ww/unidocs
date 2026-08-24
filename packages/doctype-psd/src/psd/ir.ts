import { encode, decode } from "fast-png";
import { createSBlob } from "@unidocs/protocol";
import type { PsdDoc, Layer, Mask } from "../model/types.js";
import { isRef, type BlobStore, type PixelRef } from "../render/pixel-source.js";

/** Byte-free IR shape for a Mask: pixels are always {width,height[,hash]}. */
interface IrMask {
  bounds: [number, number, number, number];
  defaultColor: 0 | 255;
  inverted: boolean;
  pixels: { width: number; height: number; hash?: string };
}

/** Byte-free IR shape for a Layer: `pixels` (if present) is a PixelRef triple
 *  without the branded SBlob (JSON cannot carry the symbol). */
type IrLayer = Omit<Layer, "pixels" | "mask" | "children"> & {
  pixels?: { width: number; height: number; hash: string };
  mask?: IrMask | null;
  children?: IrLayer[];
};

interface Ir {
  canvas: PsdDoc["canvas"];
  layers: IrLayer[];
}

function pixelRefWire(ref: PixelRef): { width: number; height: number; hash: string } {
  return { width: ref.width, height: ref.height, hash: ref.hash };
}

async function serializeMask(mask: Mask, store: BlobStore): Promise<IrMask> {
  const { pixels, blob, ...rest } = mask;
  if (pixels.width === 0) {
    return { ...rest, pixels: { width: 0, height: 0 } };
  }
  if (blob) {
    return { ...rest, pixels: { width: pixels.width, height: pixels.height, hash: blob.hash } };
  }
  const png = encode({ width: pixels.width, height: pixels.height, data: pixels.data, channels: 4, depth: 8 });
  const hash = await store.put(png);
  return { ...rest, pixels: { width: pixels.width, height: pixels.height, hash } };
}

async function deserializeMask(irMask: IrMask, store: BlobStore): Promise<Mask> {
  const { pixels, ...rest } = irMask;
  if (pixels.hash === undefined) {
    return { ...rest, pixels: { width: 0, height: 0, data: new Uint8ClampedArray(0) } };
  }
  const bytes = await store.get(pixels.hash);
  if (bytes === null) {
    throw new Error(`ir: no blob found in store for mask hash "${pixels.hash}"`);
  }
  const decoded = decode(bytes);
  const data =
    decoded.data instanceof Uint8ClampedArray
      ? decoded.data
      : new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length);
  return {
    ...rest,
    pixels: { width: decoded.width, height: decoded.height, data },
    blob: createSBlob(pixels.hash),
  };
}

async function serializeLayer(layer: Layer, store: BlobStore): Promise<IrLayer> {
  const { pixels, mask, children, ...rest } = layer;
  const irLayer: IrLayer = { ...rest };

  if (pixels !== undefined) {
    if (isRef(pixels)) {
      irLayer.pixels = pixelRefWire(pixels);
    } else {
      const png = encode({ width: pixels.width, height: pixels.height, data: pixels.data, channels: 4, depth: 8 });
      const hash = await store.put(png);
      irLayer.pixels = { width: pixels.width, height: pixels.height, hash };
    }
  }

  if (mask !== undefined) {
    irLayer.mask = mask === null ? null : await serializeMask(mask, store);
  }

  if (children !== undefined) {
    irLayer.children = await Promise.all(children.map((c) => serializeLayer(c, store)));
  }

  return irLayer;
}

async function deserializeLayer(irLayer: IrLayer, store: BlobStore): Promise<Layer> {
  const { pixels, mask, children, ...rest } = irLayer;
  const layer: Layer = { ...rest } as Layer;

  if (pixels !== undefined) {
    layer.pixels = {
      width: pixels.width,
      height: pixels.height,
      hash: pixels.hash,
      blob: createSBlob(pixels.hash),
    };
  }

  if (mask !== undefined) {
    layer.mask = mask === null ? null : await deserializeMask(mask, store);
  }

  if (children !== undefined) {
    layer.children = await Promise.all(children.map((c) => deserializeLayer(c, store)));
  }

  return layer;
}

/** Serializes a PsdDoc to a byte-free JSON IR: every layer's resident pixel
 *  buffer (and mask pixel buffer) is PNG-encoded and stored in `store`,
 *  replaced in the IR by a `{width,height,hash}` reference. Layers whose
 *  pixels are already a PixelRef keep their existing hash (not re-stored).
 *  Branded SBlobs are never written into the JSON. */
export async function serialize(doc: PsdDoc, store: BlobStore): Promise<Uint8Array> {
  const ir: Ir = {
    canvas: doc.canvas,
    layers: await Promise.all(doc.layers.map((l) => serializeLayer(l, store))),
  };
  return new TextEncoder().encode(JSON.stringify(ir));
}

/** Deserializes bytes produced by `serialize` back into a PsdDoc. Layer
 *  pixels are reconstructed as lazy PixelRefs (not fetched/decoded) — the
 *  compositor faults them in on demand. Mask pixels, which the compositor
 *  reads synchronously, are eagerly fetched and decoded back to resident
 *  Pixels. Both carry a branded SBlob so `collectSBlobRefs` can pin them. */
export async function deserialize(bytes: Uint8Array, store: BlobStore): Promise<PsdDoc> {
  const ir = JSON.parse(new TextDecoder().decode(bytes)) as Ir;
  return {
    canvas: ir.canvas,
    layers: await Promise.all(ir.layers.map((l) => deserializeLayer(l, store))),
  };
}
