import type { DocumentTypeContext, SBlob, SValue } from "@unidocs/core";
import type {
  BlendMode,
  Canvas,
  DropShadow,
  LayerType,
  PsdDoc,
  Stroke,
} from "./model/types.js";
import { deserialize, serialize } from "./psd/ir.js";
import { casBlobStore } from "./psd/cas-blobstore.js";
import type { BlobStore } from "./render/pixel-source.js";

export interface PsdStoredPixels {
  readonly width: number;
  readonly height: number;
  readonly blob?: SBlob;
}

export interface PsdStoredMask {
  readonly pixels: PsdStoredPixels;
  readonly bounds: readonly [number, number, number, number];
  readonly defaultColor: 0 | 255;
  readonly inverted: boolean;
}

export interface PsdStoredLayer {
  readonly id: string;
  readonly type: LayerType;
  readonly name: string;
  readonly bounds: readonly [number, number, number, number];
  readonly opacity: number;
  readonly fillOpacity?: number;
  readonly blendMode: BlendMode;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly clipping: boolean;
  readonly pixels?: PsdStoredPixels;
  readonly mask?: PsdStoredMask | null;
  readonly adjustType?: string;
  readonly params?: Readonly<Record<string, SValue>>;
  readonly colorOverlay?: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly opacity: number;
  };
  readonly stroke?: Stroke;
  readonly dropShadow?: DropShadow;
  readonly provenance?: {
    readonly model: string;
    readonly seed: number;
    readonly prompt: string;
  };
  readonly children?: readonly PsdStoredLayer[];
}

export interface PsdStoredDoc {
  readonly canvas: Canvas;
  readonly layers: readonly PsdStoredLayer[];
}

interface JsonPixelRef {
  width: number;
  height: number;
  hash?: string;
}

interface JsonMask {
  pixels: JsonPixelRef;
  bounds: [number, number, number, number];
  defaultColor: 0 | 255;
  inverted: boolean;
}

interface JsonLayer extends Omit<PsdStoredLayer, "pixels" | "mask" | "children"> {
  pixels?: JsonPixelRef;
  mask?: JsonMask | null;
  children?: JsonLayer[];
}

interface JsonDoc {
  canvas: Canvas;
  layers: JsonLayer[];
}

/** Externalize resident/lazy pixels and return the immutable SValue TDoc. */
export async function storePsdDoc(
  doc: PsdDoc,
  context: DocumentTypeContext,
): Promise<PsdStoredDoc> {
  const bytes = await serialize(doc, casBlobStore(context));
  const ir = JSON.parse(new TextDecoder().decode(bytes)) as JsonDoc;
  return Object.freeze({
    canvas: Object.freeze({ ...ir.canvas }),
    layers: Object.freeze(await Promise.all(ir.layers.map(layer => storeLayer(layer, context)))),
  });
}

/** Materialize the editing/render model from a persistent SValue TDoc. */
export async function materializePsdDoc(
  state: PsdStoredDoc,
  context: DocumentTypeContext,
): Promise<PsdDoc> {
  return materializePsdDocFromStore(state, casBlobStore(context));
}

/** Materialize a persistent PSD state in browser or server environments. */
export async function materializePsdDocFromStore(
  state: PsdStoredDoc,
  store: BlobStore,
): Promise<PsdDoc> {
  const ir: JsonDoc = {
    canvas: { ...state.canvas },
    layers: state.layers.map(loadLayer),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(ir));
  return deserialize(bytes, store);
}

async function storeLayer(
  layer: JsonLayer,
  context: DocumentTypeContext,
): Promise<PsdStoredLayer> {
  const { pixels, mask, children, ...rest } = layer;
  return Object.freeze({
    ...rest,
    ...(pixels !== undefined ? { pixels: await storePixels(pixels, context) } : {}),
    ...(mask !== undefined ? {
      mask: mask === null ? null : Object.freeze({
        ...mask,
        pixels: await storePixels(mask.pixels, context),
      }),
    } : {}),
    ...(children !== undefined ? {
      children: Object.freeze(await Promise.all(children.map(child => storeLayer(child, context)))),
    } : {}),
  }) as PsdStoredLayer;
}

async function storePixels(
  pixels: JsonPixelRef,
  context: DocumentTypeContext,
): Promise<PsdStoredPixels> {
  if (pixels.hash === undefined) return Object.freeze({ width: pixels.width, height: pixels.height });
  const blob = await context.makeSBlob(pixels.hash, async () => {
    throw new Error(`PSD pixel SBlob ${pixels.hash} was not stored during externalization`);
  });
  return Object.freeze({ width: pixels.width, height: pixels.height, blob });
}

function loadLayer(layer: PsdStoredLayer): JsonLayer {
  const { pixels, mask, children, ...rest } = layer;
  return {
    ...rest,
    ...(pixels !== undefined ? { pixels: loadPixels(pixels) } : {}),
    ...(mask !== undefined ? {
      mask: mask === null ? null : {
        ...mask,
        bounds: [...mask.bounds],
        pixels: loadPixels(mask.pixels),
      },
    } : {}),
    ...(children !== undefined ? { children: children.map(loadLayer) } : {}),
    bounds: [...layer.bounds],
  } as JsonLayer;
}

function loadPixels(pixels: PsdStoredPixels): JsonPixelRef {
  return {
    width: pixels.width,
    height: pixels.height,
    ...(pixels.blob !== undefined ? { hash: pixels.blob.hash } : {}),
  };
}
