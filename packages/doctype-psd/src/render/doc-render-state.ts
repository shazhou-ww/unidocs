import type { PsdDoc, Pixels, Layer } from "../model/types.js";
import type { PsdOp } from "../ops/index.js";
import type { BlobStore } from "./pixel-source.js";
import type { RenderCtx } from "./composite.js";
import { PixelCache } from "./pixel-source.js";
import { render } from "./composite.js";
import { renderRegionDirect } from "./region.js";
import { IncrementalCompositor } from "./incremental.js";
import { tilesForRect } from "./tile-grid.js";

type Rect = [number, number, number, number];

/** Crop a full-canvas frame to `rect`, matching `renderRegion`'s clamping so
 *  the two paths return identical dimensions as well as identical pixels. */
function cropFrom(full: Pixels, doc: PsdDoc, rect: Rect): Pixels {
  const t = Math.max(0, Math.floor(rect[0])), l = Math.max(0, Math.floor(rect[1]));
  const b = Math.min(doc.canvas.height, Math.ceil(rect[2])), r = Math.min(doc.canvas.width, Math.ceil(rect[3]));
  const w = Math.max(0, r - l), h = Math.max(0, b - t);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((t + y) * full.width + l) * 4;
    data.set(full.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/** Decoded RGBA bytes the whole layer tree would occupy. Works on a lazy doc
 *  too: a `PixelRef` carries `width`/`height` without holding any data. */
function decodedBytes(layers: readonly Layer[]): number {
  let n = 0;
  for (const l of layers) {
    if (l.pixels) n += l.pixels.width * l.pixels.height * 4;
    if (l.mask?.pixels) n += l.mask.pixels.width * l.mask.pixels.height * 4;
    if (l.children) n += decodedBytes(l.children);
  }
  return n;
}

/**
 * Per-document render state that OUTLIVES a single request — the server-side
 * counterpart of the browser's `RenderCore`.
 *
 * What it replaces: `runQuery` used to build `new PixelCache(...)` on every
 * `getPreview`, so each preview re-fetched and re-PNG-decoded every layer from
 * the CAS, and there was no tile state at all, so any edit forced a
 * full-canvas recomposite of the whole stack. On a 3556x2000 document that is
 * ~330 ms of decode plus ~700 ms of compositing per preview, repaid on every
 * step of an agent's edit/preview loop.
 *
 * Holding one `PixelCache` and one `IncrementalCompositor` for the lifetime of
 * the Editor DO instance turns both into once-per-change costs: decoded pixels
 * stay warm, and running an op through `applyOps` invalidates only the tiles
 * its dirty rect touches, so the next preview re-composites just those.
 *
 * ## Memory
 *
 * An Editor DO gets a hard 128 MB isolate, and a real PSD's decoded layers
 * alone can exceed that (landing.psd: 125 MB across 23 layers), so every cache
 * here is byte-budgeted and the totals are chosen to fit — deliberately NOT
 * sized to the document the way the browser sizes its cache. Steady state is
 * `pixelCacheBytes + tileCacheBytes + checkpointBytes`; a full-canvas preview
 * additionally allocates one transient W*H*4 frame (27 MB for that document)
 * which is handed to the caller and not retained here.
 */
export interface DocRenderStateOptions {
  /** Decoded layer/mask pixels (LRU by content hash). */
  pixelCacheBytes?: number;
  /** Finished composited tiles. */
  tileCacheBytes?: number;
  /** Per-tile `fold[0, activeLayer)` checkpoints. Least valuable of the three
   *  on a server (the agent edits a different layer each step, which discards
   *  them anyway), so it gets the smallest share. */
  checkpointBytes?: number;
  tileSize?: number;
}

/** Budgets chosen to sit inside a 128 MB Durable Object isolate alongside one
 *  transient full-canvas frame. Tune together, not individually. */
export const SERVER_PIXEL_CACHE_BYTES = 48 * 1024 * 1024;
export const SERVER_TILE_CACHE_BYTES = 24 * 1024 * 1024;
export const SERVER_CHECKPOINT_BYTES = 8 * 1024 * 1024;

export class DocRenderState {
  readonly #store: BlobStore;
  readonly #cache: PixelCache;
  readonly #pixelCacheBytes: number;
  readonly #tileCacheBytes: number;
  readonly #checkpointBytes: number;
  readonly #tileSize: number;
  #compositor: IncrementalCompositor | null = null;

  constructor(store: BlobStore, opts: DocRenderStateOptions = {}) {
    this.#store = store;
    this.#pixelCacheBytes = opts.pixelCacheBytes ?? SERVER_PIXEL_CACHE_BYTES;
    this.#cache = new PixelCache(this.#pixelCacheBytes);
    this.#tileCacheBytes = opts.tileCacheBytes ?? SERVER_TILE_CACHE_BYTES;
    this.#checkpointBytes = opts.checkpointBytes ?? SERVER_CHECKPOINT_BYTES;
    this.#tileSize = opts.tileSize ?? 256;
  }

  /** The warm render context, for paths that don't go through the tile grid
   *  (a single-layer preview renders an isolated one-layer document, which has
   *  nothing to do with this document's tiles — but its pixels are the same
   *  blobs, so it still wants the warm decoded-pixel cache). */
  get ctx(): RenderCtx {
    return { store: this.#store, cache: this.#cache };
  }

  /** Live footprint, so a host with a hard ceiling can observe rather than infer. */
  get cacheBytes(): { pixels: number; tiles: number; checkpoints: number } {
    const tiles = this.#compositor?.cacheBytes ?? { tiles: 0, checkpoints: 0 };
    return { pixels: this.#cache.sizeBytes, tiles: tiles.tiles, checkpoints: tiles.checkpoints };
  }

  /**
   * Whether tiled rendering is affordable for `doc`.
   *
   * This is the load-bearing decision in this class. A full-canvas render
   * touches each layer EXACTLY ONCE, so it runs fine with a pixel cache far
   * smaller than the document — entries evicted behind it are never wanted
   * again. Tiled rendering inverts that: every tile walks the whole layer
   * stack, so if the decoded layers do not all fit, each tile evicts the
   * layers the next tile needs and every tile re-fetches and re-PNG-decodes
   * the entire document.
   *
   * Measured on a 3556x2000 file with 125 MB of decoded layers against a
   * 48 MB cache: 1.4 s for the stateless full render, 56 s tiled. The browser
   * escapes this by sizing its cache to the document (128 MB–1 GB); an Editor
   * DO has a 128 MB isolate and cannot. So the tile path is used only when the
   * document actually fits, and otherwise we fall back to the stateless
   * entrypoints — which still keep the warm cache, and still take
   * `renderRegionDirect` for a rect instead of compositing the whole canvas
   * and cropping.
   */
  #tileable(doc: PsdDoc): boolean {
    if (this.#docBytesFor !== doc) {
      this.#docBytesFor = doc;
      this.#docBytes = decodedBytes(doc.layers);
    }
    return this.#docBytes <= this.#pixelCacheBytes;
  }
  #docBytesFor: PsdDoc | null = null;
  #docBytes = 0;

  /**
   * The resident compositor, positioned on `doc`.
   *
   * Identity is the version key: the doc is replaced (never mutated) on every
   * edit, so a mismatch means this state is looking at a document it did not
   * produce — a rollback, a replay of the delta log from an older base, or a
   * restore. `reset` drops the tile-level state (which belongs to the old
   * layer stack) but deliberately KEEPS the decoded-pixel cache, so unchanged
   * layers are not re-fetched.
   */
  #positioned(doc: PsdDoc): IncrementalCompositor {
    if (!this.#compositor) {
      this.#compositor = new IncrementalCompositor(doc, {
        tileSize: this.#tileSize,
        ctx: this.ctx,
        tileCacheBytes: this.#tileCacheBytes,
        checkpointBytes: this.#checkpointBytes,
      });
    } else if (this.#compositor.doc !== doc) {
      this.#compositor.reset(doc);
    }
    return this.#compositor;
  }

  /**
   * Applies `ops` to `doc` through the resident compositor and returns the new
   * document — same result as the free `apply()`, but each op also invalidates
   * only the tiles its dirty rect covers instead of the whole canvas.
   *
   * `resolveDoc` is the caller's job for a flip (see `apply` in ops/index.ts):
   * it produces a new document, so the compositor is re-positioned onto it.
   */
  async applyOps(
    ops: readonly PsdOp[],
    doc: PsdDoc,
    resolveForOp?: (doc: PsdDoc, op: PsdOp) => Promise<PsdDoc>,
  ): Promise<PsdDoc> {
    let comp = this.#positioned(doc);
    for (const op of ops) {
      if (resolveForOp) {
        const resolved = await resolveForOp(comp.doc, op);
        if (resolved !== comp.doc) comp = this.#positioned(resolved);
      }
      await comp.applyOp(op);
    }
    return comp.doc;
  }

  /**
   * The last full-canvas composite, for the non-tileable path only, keyed on
   * document identity (the doc is replaced on every edit, so identity is the
   * version). This is the per-document equivalent of `renderCached`'s
   * module-global slot: without it a repeat preview of an unchanged document
   * would re-composite the whole canvas, and with the global one, two
   * documents sharing an isolate evict each other's frame.
   */
  #frame: { doc: PsdDoc; px: Promise<Pixels> } | null = null;

  #cachedFrame(doc: PsdDoc): Promise<Pixels> {
    if (this.#frame?.doc === doc) return this.#frame.px;
    const px = render(doc, this.ctx);
    this.#frame = { doc, px };
    // A rejected render must not stick: a transient blob failure would
    // otherwise be cached forever and brick the document.
    px.catch(() => {
      if (this.#frame?.px === px) this.#frame = null;
    });
    return px;
  }

  /** Full-canvas composite. Byte-identical to `render(doc)`; when the document
   *  fits the pixel cache (see `#tileable`) clean tiles are reused, so after a
   *  small edit only the dirty ones are recomputed. */
  async composite(doc: PsdDoc): Promise<Pixels> {
    if (!this.#tileable(doc)) return this.#cachedFrame(doc);
    return this.#positioned(doc).composite();
  }

  /**
   * Region composite, assembled from the tile grid. Byte-identical to
   * `renderRegion(doc, rect)` (render-then-crop) but it only composites the
   * tiles the rect actually touches, and reuses any that are already clean.
   */
  async region(doc: PsdDoc, rect: Rect): Promise<Pixels> {
    // Too big to tile (see `#tileable`). If a full frame for exactly this
    // document is already in hand, cropping it is free; otherwise composite
    // straight into the region buffer rather than building a whole canvas to
    // throw most of it away (what `renderRegion` does), so only the layers
    // intersecting the rect are faulted in at all.
    if (!this.#tileable(doc)) {
      if (this.#frame?.doc === doc) return cropFrom(await this.#frame.px, doc, rect);
      return renderRegionDirect(doc, rect, this.ctx);
    }
    const comp = this.#positioned(doc);
    const { width: cw, height: ch } = doc.canvas;
    const t = Math.max(0, Math.floor(rect[0])), l = Math.max(0, Math.floor(rect[1]));
    const b = Math.min(ch, Math.ceil(rect[2])), r = Math.min(cw, Math.ceil(rect[3]));
    const w = Math.max(0, r - l), h = Math.max(0, b - t);
    const data = new Uint8ClampedArray(w * h * 4);
    if (w === 0 || h === 0) return { width: w, height: h, data };

    for (const tile of tilesForRect(doc.canvas, comp.tileSize, [t, l, b, r])) {
      const px = await comp.readTile(tile.tx, tile.ty);
      const [tt, tl] = tile.region;
      // Copy the tile ∩ rect overlap, in rect-local coordinates.
      const y0 = Math.max(t, tt), y1 = Math.min(b, tt + px.height);
      const x0 = Math.max(l, tl), x1 = Math.min(r, tl + px.width);
      for (let cy = y0; cy < y1; cy++) {
        const src = ((cy - tt) * px.width + (x0 - tl)) * 4;
        const dst = ((cy - t) * w + (x0 - l)) * 4;
        data.set(px.data.subarray(src, src + (x1 - x0) * 4), dst);
      }
    }
    return { width: w, height: h, data };
  }
}
