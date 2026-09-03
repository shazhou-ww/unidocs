import { readPsd, type Layer as AgLayer } from "ag-psd";
import type {
  PsdDoc, Layer, BlendMode, Mask,
  Degradation, LayerText, LayerParagraphRun, LayerParagraphStyle, LayerTextRun,
  LayerTextStyle, LayerVector, LayerSmartObject, TextUneditableReason,
} from "../model/types.js";
import { installCanvasShim } from "./canvas-shim.js";

/**
 * Map an ag-psd layer mask. The mask value is grayscale in channel 0 of the
 * RGBA imageData; `defaultColor` (0/255) fills the area outside the mask rect.
 * A disabled mask, or an empty one that defaults to fully-visible (255), is a
 * no-op and dropped.
 */
function mapMask(m: AgLayer["mask"]): Mask | undefined {
  if (!m || m.disabled) return undefined;
  const id = (m as { imageData?: { width: number; height: number; data: Uint8ClampedArray } }).imageData;
  const hasPixels = !!id && id.width > 0 && id.height > 0;
  const defaultColor: 0 | 255 = m.defaultColor === 0 ? 0 : 255;
  if (!hasPixels && defaultColor === 255) return undefined;
  return {
    pixels: hasPixels
      ? { width: id!.width, height: id!.height, data: id!.data }
      : { width: 0, height: 0, data: new Uint8ClampedArray(0) },
    bounds: [m.top ?? 0, m.left ?? 0, m.bottom ?? 0, m.right ?? 0],
    defaultColor,
    inverted: false,
  };
}

/** Map an ag-psd adjustment (space-named type) to our PSD 4-char key + params. */
function mapAdjustType(t: string | undefined): string {
  switch (t) {
    case "black & white": return "blwh";
    case "hue/saturation": return "hue2";
    case "brightness/contrast": return "brit";
    case "levels": return "levl";
    case "curves": return "curv";
    default: return (t ?? "unknown").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "unknown";
  }
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** ag-psd's `Color` is a union (RGB/HSB/CMYK/…); we only carry the RGB shape. */
function rgbOf(c: unknown): { r: number; g: number; b: number } | undefined {
  const v = c as { r?: unknown; g?: unknown; b?: unknown } | undefined;
  return v && isNum(v.r) && isNum(v.g) && isNum(v.b) ? { r: v.r, g: v.g, b: v.b } : undefined;
}

/** ag-psd 的 fontCaps 是个数字枚举:0 正常 / 1 小型大写 / 2 全大写。 */
function capsOf(v: unknown): LayerTextStyle["caps"] | undefined {
  return v === 1 ? "small" : v === 2 ? "all" : v === 0 ? "none" : undefined;
}

/**
 * 一段 ag-psd TextStyle → 我们的 LayerTextStyle。
 *
 * 只映射**重排时用得上**的字段。有意留在外面的:antiAlias(渲染器自己决定
 * 抗锯齿)、super/subscript 与 smallCapSize(等真遇到再说)、language/tsume/
 * styleRunAlignment(CJK 细节,我们还没到那一步)。
 */
function mapTextStyle(s: NonNullable<AgLayer["text"]>["style"]): LayerTextStyle {
  if (!s) return {};
  const fill = rgbOf(s.fillColor);
  const stroke = rgbOf(s.strokeColor);
  return {
    ...(s.font?.name ? { font: s.font.name } : {}),
    ...(isNum(s.fontSize) ? { size: s.fontSize } : {}),
    // ag-psd's text-engine colour encoding round-trips with float drift
    // (e.g. 28 -> 27.999); model/types.ts promises 0..255 integers, so round
    // here rather than let every downstream consumer see near-integer floats.
    ...(fill ? { color: { r: Math.round(fill.r), g: Math.round(fill.g), b: Math.round(fill.b) } } : {}),
    ...(isNum(s.tracking) ? { tracking: s.tracking } : {}),
    ...(isNum(s.leading) ? { leading: s.leading } : {}),
    ...(capsOf(s.fontCaps) ? { caps: capsOf(s.fontCaps) } : {}),
    ...(s.fauxBold !== undefined ? { fauxBold: !!s.fauxBold } : {}),
    ...(s.fauxItalic !== undefined ? { fauxItalic: !!s.fauxItalic } : {}),
    ...(isNum(s.horizontalScale) ? { horizontalScale: s.horizontalScale } : {}),
    ...(isNum(s.verticalScale) ? { verticalScale: s.verticalScale } : {}),
    ...(s.autoKerning !== undefined ? { autoKerning: !!s.autoKerning } : {}),
    ...(isNum(s.kerning) ? { kerning: s.kerning } : {}),
    ...(isNum(s.baselineShift) ? { baselineShift: s.baselineShift } : {}),
    ...(s.underline !== undefined ? { underline: !!s.underline } : {}),
    ...(s.strikethrough !== undefined ? { strikethrough: !!s.strikethrough } : {}),
    ...(s.ligatures !== undefined ? { ligatures: !!s.ligatures } : {}),
    ...(stroke ? { strokeColor: { r: Math.round(stroke.r), g: Math.round(stroke.g), b: Math.round(stroke.b) } } : {}),
    ...(isNum(s.outlineWidth) ? { strokeWidth: s.outlineWidth } : {}),
  };
}

function mapParagraphStyle(p: NonNullable<AgLayer["text"]>["paragraphStyle"]): LayerParagraphStyle {
  if (!p) return {};
  return {
    ...(p.justification ? { justification: p.justification } : {}),
    ...(isNum(p.firstLineIndent) ? { firstLineIndent: p.firstLineIndent } : {}),
    ...(isNum(p.startIndent) ? { startIndent: p.startIndent } : {}),
    ...(isNum(p.endIndent) ? { endIndent: p.endIndent } : {}),
    ...(isNum(p.spaceBefore) ? { spaceBefore: p.spaceBefore } : {}),
    ...(isNum(p.spaceAfter) ? { spaceAfter: p.spaceAfter } : {}),
  };
}

const nonEmpty = <T extends object>(o: T): T | undefined => (Object.keys(o).length ? o : undefined);

/**
 * PSD 里我们**复刻不了**的排版特性。命中任何一条,这层的文字就只能贴烘焙
 * 像素:重排出来必然不像,不如老实说不支持,让 agent 去走 editPixels。
 *
 * 缺字体**不在这里** —— 那不是文件的属性,是"这台机器上有没有装"的属性,
 * 只有渲染时才知道。
 */
function textUneditable(t: NonNullable<AgLayer["text"]>): TextUneditableReason[] {
  const out: TextUneditableReason[] = [];
  // warp.style 存在且不是 'none' 才算真的变形过。
  if (t.warp?.style && t.warp.style !== "none") out.push("warp");
  if (t.textPath) out.push("text-path");
  if (t.gridding === "round" || t.gridInfo?.isOn) out.push("grid");
  return out;
}

function mapText(t: AgLayer["text"]): { text: LayerText; degraded: Degradation } | undefined {
  if (!t || typeof t.text !== "string") return undefined;
  const style = mapTextStyle(t.style);
  const paragraphStyle = mapParagraphStyle(t.paragraphStyle);
  // run 的 length 是字符数,顺次覆盖 content。长度为 0 的段没有意义,丢掉。
  const runs: LayerTextRun[] = (t.styleRuns ?? [])
    .filter((r) => isNum(r?.length) && r.length > 0)
    .map((r) => ({ length: r.length, style: mapTextStyle(r.style) }));
  const paragraphRuns: LayerParagraphRun[] = (t.paragraphStyleRuns ?? [])
    .filter((r) => isNum(r?.length) && r.length > 0)
    .map((r) => ({ length: r.length, style: mapParagraphStyle(r.style) }));
  const uneditable = textUneditable(t);
  return {
    text: {
      content: t.text,
      ...(nonEmpty(style) ? { style } : {}),
      ...(runs.length ? { runs } : {}),
      ...(nonEmpty(paragraphStyle) ? { paragraphStyle } : {}),
      ...(paragraphRuns.length ? { paragraphRuns } : {}),
      ...(Array.isArray(t.transform) ? { transform: [...t.transform] } : {}),
      ...(t.shapeType ? { shapeType: t.shapeType } : {}),
      ...(Array.isArray(t.boxBounds) ? { boxBounds: [...t.boxBounds] } : {}),
      ...(Array.isArray(t.pointBase) ? { pointBase: [...t.pointBase] } : {}),
      ...(t.orientation ? { orientation: t.orientation } : {}),
      ...(uneditable.length ? { uneditable } : {}),
    },
    degraded: {
      reason: "文字层已栅格化",
      detail: uneditable.length
        ? `渲染与导出使用 PSD 烘焙像素；文字不可重排（${uneditable.join("、")}）`
        : "渲染与导出使用 PSD 烘焙像素；文字内容可编辑，重排需要本机有对应字体",
    },
  };
}

function mapVector(a: AgLayer): { vector: LayerVector; degraded: Degradation } | undefined {
  const paths = a.vectorMask?.paths ?? [];
  if (!paths.length && !a.vectorFill && !a.vectorStroke) return undefined;
  return {
    vector: {
      ...(a.vectorFill ? { fill: a.vectorFill } : {}),
      ...(a.vectorStroke ? { stroke: a.vectorStroke } : {}),
      ...(paths.length
        ? {
            pathSummary: {
              subpaths: paths.length,
              knots: paths.reduce((n, p) => n + (p.knots?.length ?? 0), 0),
            },
          }
        : {}),
    },
    degraded: {
      reason: "矢量形状已栅格化",
      // Deliberately precise about how little survives: `fill`/`stroke` are
      // carried verbatim and DO round-trip through save(), but the paths
      // themselves are reduced to counts (`pathSummary`) and save() writes no
      // vectorMask at all — re-importing an exported file yields a shape layer
      // with zero paths. Pinned by save-roundtrip-ir.test.ts.
      detail: "填充与描边样式保留为元数据；路径仅汇总为子路径与锚点数量，不会写回矢量蒙版；渲染与导出使用烘焙像素",
    },
  };
}

function mapSmartObject(a: AgLayer): { smartObject?: LayerSmartObject; degraded: Degradation } | undefined {
  const p = a.placedLayer;
  if (!p) return undefined;
  // `placedId` is what ties the layer to its embedded source, so a placed
  // layer without an `id` cannot be modelled as a smart object and keeps the
  // plain raster verdict. The fidelity loss is real all the same — this used
  // to return `undefined`, i.e. the flattest possible smart object recorded
  // NOTHING in the ledger, which defeats the ledger's whole purpose.
  if (!p.id) return { degraded: { reason: "智能对象已展平", detail: "源文档未内嵌" } };
  return {
    smartObject: {
      placedId: p.id,
      ...(Array.isArray(p.transform) ? { transform: [...p.transform] } : {}),
      ...(p.placed ? { sourceName: p.placed } : {}),
    },
    degraded: {
      reason: "智能对象已展平",
      detail: p.placed ? `源：${p.placed}` : "源文档未内嵌",
    },
  };
}

/** ag-psd's per-effect keys, in the names the design doc uses. */
const EFFECT_LABELS: Record<string, string> = {
  dropShadow: "投影", innerShadow: "内阴影", outerGlow: "外发光", innerGlow: "内发光",
  bevel: "斜面和浮雕", satin: "光泽", solidFill: "颜色叠加", stroke: "描边",
  gradientOverlay: "渐变叠加", patternOverlay: "图案叠加",
};
/** Not effects: the effect-block toggle and the global effect scale. */
const NON_EFFECT_KEYS = new Set(["disabled", "scale"]);

/**
 * One degradation per layer effect present on the layer that this loader does
 * NOT carry into the model — spec §5.2's third degradation kind.
 *
 * The model understands exactly three effects (solidFill → colorOverlay,
 * stroke, dropShadow), and even those only in their solid-colour, enabled
 * form. Everything else — inner shadow, glows, bevel, satin, gradient/pattern
 * overlay, and a gradient/pattern or disabled stroke — was previously dropped
 * on the floor with no entry at all, so a document could lose half its
 * appearance and report perfect fidelity.
 *
 * A DISABLED effect is reported too, with its own wording: Photoshop is not
 * rendering it either, so nothing changes on screen, but the loader still
 * discards the data and an export can never bring it back.
 */
function unsupportedEffects(
  fx: Record<string, unknown> | undefined,
  mapped: { solidFill: boolean; stroke: boolean; dropShadow: boolean },
): Degradation[] {
  if (!fx) return [];
  const out: Degradation[] = [];
  for (const [key, value] of Object.entries(fx)) {
    if (NON_EFFECT_KEYS.has(key) || !value) continue;
    const entries = Array.isArray(value) ? value : [value];
    if (entries.length === 0) continue;
    // Skip the three we actually mapped. (If one key holds several entries and
    // only some were mapped, we stay silent rather than risk a false alarm.)
    if (key === "solidFill" && mapped.solidFill) continue;
    if (key === "stroke" && mapped.stroke) continue;
    if (key === "dropShadow" && mapped.dropShadow) continue;
    const anyEnabled = entries.some((e) => (e as { enabled?: boolean } | null)?.enabled !== false);
    out.push({
      reason: `不支持的图层效果：${EFFECT_LABELS[key] ?? key}`,
      detail: anyEnabled
        ? "导入时未保留，渲染与导出均不包含该效果"
        : "源文件中已停用，导入时未保留，导出后无法恢复",
    });
  }
  return out;
}

/**
 * Crop a layer's pixel buffer (and bounds) to the canvas rect, dropping any
 * pixels that fall outside [0,0,cw,ch]. A no-op if the layer is already
 * fully within the canvas.
 */
export function cropPixelsToCanvas(
  px: { width: number; height: number; data: Uint8ClampedArray },
  bounds: [number, number, number, number],
  cw: number, ch: number,
): { pixels: { width: number; height: number; data: Uint8ClampedArray }; bounds: [number, number, number, number] } {
  const [top, left, bottom, right] = bounds;
  const nt = Math.max(0, top), nl = Math.max(0, left);
  // Clamp bottom/right against the clamped top/left (not just the canvas) so
  // a layer entirely outside the canvas yields a degenerate, non-inverted
  // rect (e.g. [nt,nl,nt,nl]) rather than bottom<top or right<left.
  const nb = Math.max(nt, Math.min(ch, bottom)), nr = Math.max(nl, Math.min(cw, right));
  if (nt === top && nl === left && nb === bottom && nr === right) return { pixels: px, bounds };
  const nw = Math.max(0, nr - nl), nh = Math.max(0, nb - nt);
  const data = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = nl - left + x, sy = nt - top + y;
      const si = (sy * px.width + sx) * 4, di = (y * nw + x) * 4;
      data[di] = px.data[si]; data[di + 1] = px.data[si + 1];
      data[di + 2] = px.data[si + 2]; data[di + 3] = px.data[si + 3];
    }
  }
  return { pixels: { width: nw, height: nh, data }, bounds: [nt, nl, nb, nr] };
}

export function mapLayer(a: AgLayer, i: number, cw: number, ch: number): Layer {
  const isGroup = Array.isArray(a.children);
  const adj = (a as { adjustment?: { type?: string } & Record<string, unknown> }).adjustment;
  // Metadata is captured regardless of the type verdict — a vector-masked
  // adjustment keeps its path summary AND stays an adjustment.
  const textInfo = isGroup ? undefined : mapText(a.text);
  const smartInfo = isGroup ? undefined : mapSmartObject(a);
  const vectorInfo = isGroup ? undefined : mapVector(a);
  // Order matters: adjustments and smart objects commonly carry a vector mask,
  // so they must be decided BEFORE the vector check or they'd read as "fill".
  const type: Layer["type"] =
    isGroup ? "group"
    : adj ? "adjustment"
    : textInfo ? "text"
    // A placed layer with no `id` yields a degradation but no `smartObject`,
    // and stays a raster (or a fill, if it also carries a vector mask).
    : smartInfo?.smartObject ? "smartObject"
    : vectorInfo ? "fill"
    : "raster";
  let bounds: [number, number, number, number] = [a.top ?? 0, a.left ?? 0, a.bottom ?? 0, a.right ?? 0];
  let px = a.imageData
    ? { width: a.imageData.width, height: a.imageData.height, data: a.imageData.data as Uint8ClampedArray }
    : undefined;
  const mask = mapMask(a.mask);
  // Color Overlay effect (PSD "solidFill"): a solid color drawn within the
  // layer's alpha. Common on shape/vector layers (e.g. gold-tinted line art
  // whose own pixels are black).
  const fx = (a as { effects?: {
    solidFill?: Array<{ enabled?: boolean; color?: { r: number; g: number; b: number }; opacity?: number }>;
    stroke?: Array<{ enabled?: boolean; fillType?: string; blendMode?: string; opacity?: number; position?: string; size?: { value?: number }; color?: { r: number; g: number; b: number } }>;
    dropShadow?: Array<{ enabled?: boolean; blendMode?: string; opacity?: number; angle?: number; distance?: { value?: number }; size?: { value?: number }; choke?: { value?: number }; color?: { r: number; g: number; b: number } }>;
  } }).effects;
  const so = fx?.solidFill?.find((s) => s?.enabled && s.color);
  const colorOverlay = so?.color
    ? { r: so.color.r, g: so.color.g, b: so.color.b, opacity: so.opacity ?? 1 }
    : undefined;
  // Stroke effect: a coloured border. We support solid-colour strokes; gradient/
  // pattern strokes fall back to their colour if present, else are skipped.
  const st = fx?.stroke?.find((s) => s?.enabled && s.color && (s.fillType ?? "color") === "color");
  const stroke = st?.color
    ? {
        color: { r: st.color.r, g: st.color.g, b: st.color.b },
        opacity: st.opacity ?? 1,
        size: Math.max(1, Math.round(st.size?.value ?? 1)),
        position: (st.position === "inside" || st.position === "center" ? st.position : "outside") as "inside" | "outside" | "center",
        blendMode: ((st.blendMode ?? "normal").replace(/ /g, "-")) as BlendMode,
      }
    : undefined;
  // Drop Shadow effect.
  const ds = fx?.dropShadow?.find((s) => s?.enabled && s.color);
  const dropShadow = ds?.color
    ? {
        color: { r: ds.color.r, g: ds.color.g, b: ds.color.b },
        opacity: ds.opacity ?? 1,
        blendMode: ((ds.blendMode ?? "normal").replace(/ /g, "-")) as BlendMode,
        angle: ds.angle ?? 0,
        distance: ds.distance?.value ?? 0,
        size: Math.max(0, Math.round(ds.size?.value ?? 0)),
        choke: Math.max(0, Math.round(ds.choke?.value ?? 0)),
      }
    : undefined;
  // Assembled here, not next to the type verdict, because it needs the effect
  // mapping above to know which effects were actually carried over.
  const degraded: Degradation[] = [
    textInfo?.degraded, smartInfo?.degraded, vectorInfo?.degraded,
  ].filter((d): d is Degradation => !!d)
    .concat(unsupportedEffects(fx as Record<string, unknown> | undefined, {
      solidFill: !!colorOverlay, stroke: !!stroke, dropShadow: !!dropShadow,
    }));
  let adjType: string | undefined;
  let adjParams: Record<string, unknown> | undefined;
  if (adj) {
    const { type: _t, ...rest } = adj;
    adjType = mapAdjustType(adj.type);
    adjParams = rest;
  }
  // Crop overflowing pixels to the canvas to avoid retaining off-canvas
  // memory. Skipped for layers with a stroke or drop-shadow effect: both
  // read the pixel buffer beyond its own bounds (chamfer distance / offset
  // blur), so pixels outside the canvas can still influence the rendered
  // result and must be kept.
  if (px && !stroke && !dropShadow && (bounds[0] < 0 || bounds[1] < 0 || bounds[2] > ch || bounds[3] > cw)) {
    const cropped = cropPixelsToCanvas(px, bounds, cw, ch);
    px = cropped.pixels;
    bounds = cropped.bounds;
  }
  return {
    id: `l${i}_${a.name ?? "layer"}`.replace(/\s+/g, "_"),
    type,
    name: a.name ?? "",
    bounds,
    opacity: a.opacity ?? 1,
    ...(a.fillOpacity !== undefined && a.fillOpacity !== 1 ? { fillOpacity: a.fillOpacity } : {}),
    // ag-psd emits space-separated names ("color dodge", "pass through");
    // our canonical form is hyphenated ("color-dodge", "pass-through").
    blendMode: (a.blendMode ?? "normal").replace(/ /g, "-") as BlendMode,
    visible: !a.hidden,
    locked: false,
    clipping: !!a.clipping,
    // Only carry pixels for non-adjustment layers.
    ...(px && !adj ? { pixels: px } : {}),
    ...(colorOverlay ? { colorOverlay } : {}),
    ...(stroke ? { stroke } : {}),
    ...(dropShadow ? { dropShadow } : {}),
    ...(adjType ? { adjustType: adjType, params: adjParams } : {}),
    ...(mask ? { mask } : {}),
    ...(textInfo ? { text: textInfo.text } : {}),
    ...(smartInfo?.smartObject ? { smartObject: smartInfo.smartObject } : {}),
    ...(vectorInfo ? { vector: vectorInfo.vector } : {}),
    ...(degraded.length ? { degraded } : {}),
    ...(isGroup ? { children: (a.children ?? []).map((c, ci) => mapLayer(c, ci, cw, ch)) } : {}),
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
    layers: (psd.children ?? []).map((a, i) => mapLayer(a, i, psd.width, psd.height)),
  };
}
