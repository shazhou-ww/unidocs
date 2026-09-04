import type { DocumentTypeContext, SBlob, SValue } from "@unidocs/protocol";
import type {
  BlendMode,
  Canvas,
  DropShadow,
  LayerText,
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
  /** 文字层的文字描述。`storeLayer`/`loadLayer` 靠 `...rest` 把它带过持久化，
   *  运行时一直是好的——但类型里不写出来，就等于在说"这个字段不持久化"，而
   *  事实相反。危险在于 `PsdStoredDoc` 用的是显式字段：谁要是把 `storeLayer`
   *  也改成显式字段与之看齐（很自然的重构冲动），`text` 会**静默**消失，和这
   *  个分支上刚修过的 `fonts` 是同一个故障。 */
  readonly text?: LayerText;
  readonly provenance?: {
    readonly model: string;
    /** 只有真的把种子发给了 provider 的实现才写它 —— 见 model/types.ts。 */
    readonly seed?: number;
    readonly prompt: string;
  };
  readonly children?: readonly PsdStoredLayer[];
}

/** stored 侧的字体条目：`blob` 是靠 `context.makeSBlob` 建的 branded SBlob——
 *  只有这样 CAS 的保活遍历（`refsFromSValue`）才能在 stored doc 里找到这个
 *  引用，把字体钉住。 */
export interface PsdStoredFont {
  readonly postScriptName: string;
  readonly blob: SBlob;
}

export interface PsdStoredDoc {
  readonly canvas: Canvas;
  readonly layers: readonly PsdStoredLayer[];
  readonly fonts?: readonly PsdStoredFont[];
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
  fonts?: { postScriptName: string; hash: string }[];
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
    // fonts 缺席（ir.fonts undefined）时不建这个属性——上一轮在 ir.ts 立的规矩
    // 在这层也要守住，否则老文档一存一取就多出一个 fonts: [] 的形变。
    ...(ir.fonts !== undefined ? { fonts: Object.freeze(await Promise.all(ir.fonts.map(f => storeFont(f, context)))) } : {}),
  }) as PsdStoredDoc;
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
    ...(state.fonts !== undefined ? { fonts: state.fonts.map(loadFont) } : {}),
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

async function storeFont(
  font: { postScriptName: string; hash: string },
  context: DocumentTypeContext,
): Promise<PsdStoredFont> {
  const blob = await context.makeSBlob(font.hash, async () => {
    throw new Error(`PSD font SBlob ${font.hash} was not stored during externalization`);
  });
  return Object.freeze({ postScriptName: font.postScriptName, blob });
}

function loadFont(font: PsdStoredFont): { postScriptName: string; hash: string } {
  return { postScriptName: font.postScriptName, hash: font.blob.hash };
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
