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

export interface Layer {
  id: string;
  type: LayerType;
  name: string;
  bounds: [number, number, number, number]; // [top,left,bottom,right]
  opacity: number; // 0..1
  blendMode: BlendMode;
  visible: boolean;
  locked: boolean;
  clipping: boolean;
  pixels?: Pixels;                       // raster
  mask?: Mask | null;
  adjustType?: string;                   // adjustment (PSD key: brit/levl/curv/hue2/…)
  params?: Record<string, unknown>;      // adjustment params
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
