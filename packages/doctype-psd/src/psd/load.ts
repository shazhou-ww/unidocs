import { readPsd, type Layer as AgLayer } from "ag-psd";
import type { PsdDoc, Layer, BlendMode, Mask } from "../model/types.js";
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

function mapLayer(a: AgLayer, i: number): Layer {
  const isGroup = Array.isArray(a.children);
  const adj = (a as { adjustment?: { type?: string } & Record<string, unknown> }).adjustment;
  const type: Layer["type"] = isGroup ? "group" : adj ? "adjustment" : "raster";
  const px = a.imageData
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
  let adjType: string | undefined;
  let adjParams: Record<string, unknown> | undefined;
  if (adj) {
    const { type: _t, ...rest } = adj;
    adjType = mapAdjustType(adj.type);
    adjParams = rest;
  }
  return {
    id: `l${i}_${a.name ?? "layer"}`.replace(/\s+/g, "_"),
    type,
    name: a.name ?? "",
    bounds: [a.top ?? 0, a.left ?? 0, a.bottom ?? 0, a.right ?? 0],
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
