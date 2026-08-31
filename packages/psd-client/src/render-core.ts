import type { BlobStore, Layer, Pixels, PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";
import {
  DEFAULT_CACHE_BYTES, IncrementalCompositor, PixelCache, findLayer, isRef, resolvePixels,
} from "@unidocs/doctype-psd/engine";
import {
  HIT_ALPHA_THRESHOLD, alphaAt, hitInList, layerBoxOf,
  type HitCandidate, type Rect, type ResidentPixels,
} from "./layer-alpha.js";

/** Worker-agnostic render core: holds ONE persistent `IncrementalCompositor`
 *  (and its `PixelCache`) over a `BlobStore`. Built once per document; after
 *  the first frame, editing a layer only re-composites the dirty tiles from
 *  already-decoded pixels — no per-edit re-fetch from the store. This is the
 *  invariant the server render path fails to hold (it rebuilds fresh state
 *  per request), so RenderCore exists to make it hold in the browser. */
export class RenderCore {
  private readonly compositor: IncrementalCompositor;
  // Kept as fields rather than only being handed to the compositor: the hit
  // test reads single pixels out of the same warm cache, and inlining these
  // into the constructor call threw the references away.
  private readonly store: BlobStore;
  private readonly cache: PixelCache;

  constructor(doc: PsdDoc, store: BlobStore, opts: { tileSize?: number; cacheBytes?: number } = {}) {
    this.store = store;
    this.cache = new PixelCache(opts.cacheBytes ?? DEFAULT_CACHE_BYTES);
    this.compositor = new IncrementalCompositor(doc, {
      tileSize: opts.tileSize,
      ctx: { store, cache: this.cache },
    });
  }

  /** Applies one op to the resident doc; returns the dirty rect (canvas coords). */
  applyOp(op: PsdOp): Promise<[number, number, number, number]> {
    return this.compositor.applyOp(op);
  }

  /** Warms the decoded-pixel cache with every lazy layer/mask blob, fetched
   *  concurrently, so the first composite/tile pass is CPU-only (no serial
   *  per-layer network faults). Call once, right after construction, before
   *  the first `tile()`/`composite()`. Returns the count of unique blobs
   *  fetched. */
  prefetch(): Promise<number> {
    return this.compositor.prefetch();
  }

  /** Swaps the resident doc for `newDoc` (e.g. after a 409/agent rebase),
   *  keeping the decoded-pixel cache warm: layers whose blob hash is
   *  unchanged are served from cache instead of being re-fetched. */
  reset(newDoc: PsdDoc): void {
    this.compositor.reset(newDoc);
  }

  /** Reads one tile, recomputing only if dirty (else served from the tile cache). */
  tile(tx: number, ty: number): Promise<Pixels> {
    return this.compositor.readTile(tx, ty);
  }

  /** Full-canvas composite, tile-by-tile via the persistent compositor. */
  composite(): Promise<Pixels> {
    return this.compositor.composite();
  }

  get doc(): PsdDoc {
    return this.compositor.doc;
  }

  get tileSize(): number {
    return this.compositor.tileSize;
  }

  /** Faults in exactly the leaf layers `alphaAt` can actually read: it checks
   *  `layer.bounds` and returns 0 before ever consulting the lookup (see
   *  layer-alpha.ts), so a layer whose bounds fail `contains` cannot
   *  influence the caller's result. Keeping the table call-scoped (nothing
   *  persisted on `this`) means the engine's own `PixelCache` stays free to
   *  evict — a whole-document resident map would pin every decoded layer for
   *  as long as the doc keeps its identity, defeating eviction under memory
   *  pressure on large PSDs. */
  private async residentFor(layers: Layer[], contains: (b: Rect) => boolean): Promise<ResidentPixels> {
    const map = new Map<string, Pixels>();
    const walk = async (list: Layer[]): Promise<void> => {
      for (const l of list) {
        if (l.children) { await walk(l.children); continue; }
        if (!l.pixels || !contains(l.bounds as Rect)) continue;
        map.set(l.id, isRef(l.pixels) ? await resolvePixels(l.pixels, this.store, this.cache) : l.pixels);
      }
    };
    await walk(layers);
    return (layer: Layer) => map.get(layer.id) ?? null;
  }

  /**
   * Every layer under the point, topmost first — [] on a miss.
   *
   * `radius` is the click tolerance IN DOCUMENT PIXELS; the caller converts it
   * from a CSS-pixel constant, because at the 5% zoom floor three CSS pixels
   * span sixty document pixels and a fixed document-space tolerance would make
   * small things unclickable when zoomed out.
   *
   * Nothing is composited here and `IncrementalCompositor` is untouched.
   */
  async hitTest(x: number, y: number, opts: { threshold?: number; radius?: number } = {}): Promise<HitCandidate[]> {
    const r = Math.max(0, Math.round(opts.radius ?? 0));
    const points: Array<[number, number]> = r > 0
      ? [[x, y], [x - r, y], [x + r, y], [x, y - r], [x, y + r]]
      : [[x, y]];
    const containsAnyPoint = (b: Rect): boolean =>
      points.some(([px, py]) => {
        const cx = Math.floor(px);
        const cy = Math.floor(py);
        return cx >= b[1] && cx < b[3] && cy >= b[0] && cy < b[2];
      });
    const resident = await this.residentFor(this.doc.layers, containsAnyPoint);
    return hitInList(this.doc.layers, points, opts.threshold ?? HIT_ALPHA_THRESHOLD, resident);
  }

  /**
   * A layer's alpha as a single-channel coverage buffer over its own box —
   * "load layer as selection" (spec §6.1), the conversion that lets someone
   * point at a THING and get back an AREA.
   *
   * Same read path as `hitTest`; the only difference is copying the whole
   * block out instead of sampling one point, and the fault-in is scoped to
   * the target layer's own subtree rather than the whole document.
   */
  async layerAlphaRegion(layerId: string): Promise<{ bounds: Rect; data: Uint8ClampedArray } | null> {
    const layer = findLayer(this.doc.layers, layerId);
    if (!layer) return null;
    const bounds = layerBoxOf(layer);
    if (!bounds) return null;
    const [top, left, bottom, right] = bounds;
    const intersectsBox = (b: Rect): boolean => b[1] < right && b[3] > left && b[0] < bottom && b[2] > top;
    const resident = await this.residentFor([layer], intersectsBox);
    const w = Math.max(0, right - left);
    const h = Math.max(0, bottom - top);
    const data = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        data[y * w + x] = Math.round(255 * alphaAt(layer, left + x, top + y, resident, false));
      }
    }
    return { bounds, data };
  }
}
