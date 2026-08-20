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
  provenance?: { model: string; seed: number; prompt: string };
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

export interface PsdDoc { canvas: Canvas; layers: Layer[]; }
