import type { SBlob } from "@unidocs/protocol";
import type { PixelSource } from "../render/pixel-source.js";

export type BlendMode =
  | "normal" | "dissolve" | "darken" | "multiply" | "color-burn" | "linear-burn"
  | "lighten" | "screen" | "color-dodge" | "linear-dodge" | "overlay"
  | "soft-light" | "hard-light" | "vivid-light" | "linear-light"
  | "difference" | "exclusion" | "subtract" | "divide"
  | "hue" | "saturation" | "color" | "luminosity" | "pass-through";

export type LayerType = "raster" | "adjustment" | "fill" | "text" | "smartObject" | "group";

/** RGBA pixel buffer, 8-bit, length = width*height*4. */
export interface Pixels { width: number; height: number; data: Uint8ClampedArray; }

export interface Mask {
  pixels: Pixels;
  bounds: [number, number, number, number]; // [top,left,bottom,right]
  defaultColor: 0 | 255;
  inverted: boolean;
  /** Branded CAS handle for the PNG-encoded mask; compositor still reads `pixels`. */
  blob?: SBlob;
}

/** Stroke effect: a solid-colour border of width `size` px placed relative to
 *  the layer's shape edge (inside / outside / straddling it). */
export interface Stroke {
  color: { r: number; g: number; b: number }; // 0..255
  opacity: number;                             // 0..1
  size: number;                                // px
  position: "inside" | "outside" | "center";
  blendMode: BlendMode;
}

/** Drop Shadow effect: a coloured copy of the layer's shape, offset by
 *  `distance` at `angle`°, optionally blurred by `size`, drawn behind the layer. */
export interface DropShadow {
  color: { r: number; g: number; b: number }; // 0..255
  opacity: number;                             // 0..1
  blendMode: BlendMode;
  angle: number;                               // degrees (Photoshop light angle)
  distance: number;                            // px
  size: number;                                // px blur radius (0 = hard edge)
  choke: number;                               // px the shape is expanded before blur
}

/** A capability the loader could not represent, recorded so the UI can show
 *  what fidelity was lost instead of silently pretending the import was exact. */
export interface Degradation { reason: string; detail?: string }

export interface LayerTextStyle {
  font?: string;
  size?: number;
  color?: { r: number; g: number; b: number }; // 0..255
  tracking?: number;
  leading?: number;
  /** 大小写变换。烘焙图全大写而 `content` 是小写,差别就出在这里。 */
  caps?: "none" | "small" | "all";
  /** 没有真粗体/斜体字重时 Photoshop 的伪造。重排时必须知道,否则字重不对。 */
  fauxBold?: boolean;
  fauxItalic?: boolean;
  /** 字形的水平/垂直拉伸,1 = 不拉伸。 */
  horizontalScale?: number;
  verticalScale?: number;
  /** 字偶距:autoKerning 用字体自带的表,kerning 是手工覆盖值。 */
  autoKerning?: boolean;
  kerning?: number;
  baselineShift?: number;
  underline?: boolean;
  strikethrough?: boolean;
  ligatures?: boolean;
  strokeColor?: { r: number; g: number; b: number };
  strokeWidth?: number;
}

/**
 * 一段字符样式。`length` 是**字符数**,顺次覆盖 `content`。
 *
 * 这是文字层最容易被压扁的一处:一层里"第一行黑色、第二行红色且字距很大"
 * 在 PSD 里就是两个 run,而只读顶层 `style` 只能拿到第一个。
 */
export interface LayerTextRun {
  length: number;
  style: LayerTextStyle;
}

/** 段落属性。`justification` 决定改短之后往哪边收,没有它就不知道字往哪放。 */
export interface LayerParagraphStyle {
  justification?: "left" | "right" | "center" | "justify-left" | "justify-right" | "justify-center" | "justify-all";
  firstLineIndent?: number;
  startIndent?: number;
  endIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
}

export interface LayerParagraphRun {
  length: number;
  style: LayerParagraphStyle;
}

/**
 * 文字层为什么**不能**由我们重排。三种都来自 PSD 里我们复刻不了的特性;
 * 缺字体不在这里 —— 那是渲染时才知道的事,取决于本机有没有那套字体。
 */
export type TextUneditableReason = "warp" | "text-path" | "grid";

/** Text-layer metadata preserved from the PSD. The layer still RENDERS from
 *  its baked `pixels`; this is structure for the UI and the agent to read. */
export interface LayerText {
  content: string;
  /** 整层的默认样式(ag-psd 的顶层 `style`)。`runs` 为空时它就是全部。 */
  style?: LayerTextStyle;
  /** 逐段字符样式。长度之和应等于 `content` 的字符数。 */
  runs?: LayerTextRun[];
  paragraphStyle?: LayerParagraphStyle;
  paragraphRuns?: LayerParagraphRun[];
  transform?: number[];          // ag-psd's affine matrix, kept verbatim
  shapeType?: "point" | "box";
  /** `shapeType: "box"` 的文本框(换行宽度靠它),以及点文字的锚点。 */
  boxBounds?: number[];
  pointBase?: number[];
  /** 竖排文字(中日韩)。缺省横排。 */
  orientation?: "horizontal" | "vertical";
  /**
   * 非空 = 这层的文字**我们重排不了**,只能贴烘焙像素、走 editPixels。
   * 空 = 结构上可重排(能不能真画出来还要看本机有没有那套字体)。
   */
  uneditable?: TextUneditableReason[];
}

/** Vector/shape metadata preserved from the PSD. `fill`/`stroke` are ag-psd's
 *  own `VectorContent` shapes, kept verbatim rather than re-modelled. */
export interface LayerVector {
  fill?: unknown;
  stroke?: unknown;
  pathSummary?: { subpaths: number; knots: number };
}

export interface LayerSmartObject {
  placedId: string;
  transform?: number[];
  sourceName?: string;
}

export interface Layer {
  id: string;
  type: LayerType;
  name: string;
  bounds: [number, number, number, number]; // [top,left,bottom,right]
  opacity: number; // 0..1 — the whole layer (fill + effects)
  fillOpacity?: number; // 0..1 — the layer's own fill only; layer effects are unaffected. Default 1.
  blendMode: BlendMode;
  visible: boolean;
  locked: boolean;
  clipping: boolean;
  pixels?: PixelSource;                  // raster: resident Pixels or a lazy PixelRef
  mask?: Mask | null;
  adjustType?: string;                   // adjustment (PSD key: brit/levl/curv/hue2/…)
  params?: Record<string, unknown>;      // adjustment params
  colorOverlay?: { r: number; g: number; b: number; opacity: number }; // Color Overlay effect (PSD solidFill), 0..255 RGB
  stroke?: Stroke;                       // Stroke effect (a border along the layer's shape edge)
  dropShadow?: DropShadow;               // Drop Shadow effect (a coloured, offset, optionally blurred copy behind the layer)
  // seed 可选：只有真的把种子发给了 provider 的实现才该记它。qwen 适配器
  // 不发 seed，editPixels 于是不写这个字段 —— 记一个默认 0 等于假装可复现。
  provenance?: { model: string; seed?: number; prompt: string };
  text?: LayerText;                      // type === "text"
  vector?: LayerVector;                  // shape layers (and vector-masked others)
  smartObject?: LayerSmartObject;        // type === "smartObject"
  degraded?: Degradation[];              // fidelity lost on import — see psd/load.ts
  children?: Layer[];                    // group
}

export interface Canvas {
  width: number;
  height: number;
  colorMode: "RGB";
  depth: 8;
  resolution: number;
  profile: string;
}

/** 这份文档渲染文字时用到的字体。`blob` 是 branded SBlob —— CAS 的 GC 靠
 *  文档里的 SBlob 引用钉住 blob，只被租户索引引用的字体会被回收
 *  （设计文档 §3.6）。 */
export interface FontRef {
  postScriptName: string;
  blob: SBlob;
}

export interface PsdDoc { canvas: Canvas; layers: Layer[]; fonts?: FontRef[]; }
