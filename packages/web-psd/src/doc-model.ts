/**
 * Pure, DOM-free helpers over the PSD document shape. Split out of main.ts so
 * they can be unit-tested without a Worker, a canvas, or the network — and so
 * the UI layer can reuse them without pulling in the render controller.
 *
 * These mirror the engine's `Layer` structurally instead of importing
 * @unidocs/doctype-psd: web-psd deliberately has no dependency on the doc type.
 */

export type Rect = [number, number, number, number]; // [top,left,bottom,right] — the engine's convention

export interface Degradation { reason: string; detail?: string }

export interface LocalLayer {
  id: string;
  type: string;
  name: string;
  opacity: number;
  blendMode: string;
  visible: boolean;
  locked?: boolean;
  clipping?: boolean;
  fillOpacity?: number;
  bounds?: Rect;
  stroke?: unknown;
  colorOverlay?: unknown;
  dropShadow?: unknown;
  text?: { content: string; style?: Record<string, unknown> };
  vector?: { pathSummary?: { subpaths: number; knots: number } };
  smartObject?: { placedId: string; sourceName?: string };
  degraded?: Degradation[];
  children?: LocalLayer[];
}

/** Superset used only for sizing the render cache — adds the (lazy-ref or
 *  resident) pixel dimensions `decodedBytes` walks. */
export interface SizedLayer extends LocalLayer {
  pixels?: { width: number; height: number };
  mask?: { pixels: { width: number; height: number } };
  children?: SizedLayer[];
}

export interface DegradationRow { layerId: string; layerName: string; reason: string; detail?: string }
export interface TreeRow { layer: LocalLayer; depth: number; hasChildren: boolean }

/** Recursive count of every layer, including group children. */
export function countLayers(layers: LocalLayer[]): number {
  let n = 0;
  for (const l of layers) {
    n += 1;
    if (l.children) n += countLayers(l.children);
  }
  return n;
}

/** Sum of every layer's (and mask's) decoded RGBA byte size, walking groups. */
export function decodedBytes(layers: SizedLayer[]): number {
  let n = 0;
  for (const l of layers) {
    if (l.pixels) n += l.pixels.width * l.pixels.height * 4;
    if (l.mask?.pixels) n += l.mask.pixels.width * l.mask.pixels.height * 4;
    if (l.children) n += decodedBytes(l.children);
  }
  return n;
}

const CACHE_FLOOR = 128 * 1024 * 1024;   // 128 MiB — small docs still get real headroom
const CACHE_HEADROOM = 64 * 1024 * 1024; // slack for tile buffers alongside layer pixels
const CACHE_CAP = 1024 * 1024 * 1024;    // 1 GiB ceiling — don't reserve unbounded memory

/** Sizes the Worker's PixelCache to actually hold this doc's decoded layers,
 *  instead of the engine's small resident-doc default (which evicts constantly
 *  on a large PSD, making every composite re-fault from CAS). */
export function cacheBytesFor(layers: SizedLayer[]): number {
  return Math.min(CACHE_CAP, Math.max(CACHE_FLOOR, decodedBytes(layers) + CACHE_HEADROOM));
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  const [at, al, ab, ar] = a;
  const [bt, bl, bb, br] = b;
  return at < bb && ab > bt && al < br && ar > bl;
}

const KINDS: Record<string, { label: string; token: string }> = {
  text: { label: "T", token: "text" },
  fill: { label: "SHP", token: "shp" },
  group: { label: "GRP", token: "grp" },
  raster: { label: "IMG", token: "img" },
  smartObject: { label: "SO", token: "img" },
  adjustment: { label: "ADJ", token: "adj" },
};

/** Badge label + colour token for a layer type. `token` indexes the
 *  `--kind-*` CSS variables in styles.css. */
export function layerKind(type: string): { label: string; token: string } {
  return KINDS[type] ?? { label: "?", token: "grp" };
}

/** Flattens every `degraded` entry in the tree, tagged with its owning layer,
 *  for the top bar's "N 项降级" badge and its detail popover. */
export function collectDegradations(layers: LocalLayer[]): DegradationRow[] {
  const out: DegradationRow[] = [];
  const walk = (list: LocalLayer[]): void => {
    for (const l of list) {
      for (const d of l.degraded ?? []) {
        out.push({ layerId: l.id, layerName: l.name, reason: d.reason, ...(d.detail ? { detail: d.detail } : {}) });
      }
      if (l.children) walk(l.children);
    }
  };
  walk(layers);
  return out;
}

/** Top-down flattening of the layer tree for rendering: a group's children are
 *  emitted only when the group id is in `expanded`.
 *
 *  Each sibling list is walked BACKWARDS. `layers[0]` is the bottom of the
 *  document (see render/composite.ts's renderList, which composites the array
 *  front-to-back), and a layers panel reads top-of-document first — so the
 *  array's last element is the panel's first row. Reversing per level rather
 *  than reversing the flattened result is what keeps a group's children
 *  directly BELOW their group instead of above it. */
export function flattenTree(layers: LocalLayer[], expanded: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (list: LocalLayer[], depth: number): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const layer = list[i];
      const hasChildren = !!layer.children?.length;
      out.push({ layer, depth, hasChildren });
      if (hasChildren && expanded.has(layer.id)) walk(layer.children!, depth + 1);
    }
  };
  walk(layers, 0);
  return out;
}
