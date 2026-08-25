import type { PsdDoc, Pixels, Layer } from "../model/types.js";
import type { PsdOp } from "../ops/index.js";
import type { RenderCtx, Target } from "./composite.js";
import { applyOne } from "../ops/index.js";
import { foldRange } from "./composite.js";
import { allTiles, tilesForRect, tileKey, tileRegion } from "./tile-grid.js";
import { opDirtyRect, opActiveIndex } from "./dirty-rect.js";
import { resolvePixels, isRef, type PixelRef } from "./pixel-source.js";
import { ByteLru } from "./byte-lru.js";

type Rect = [number, number, number, number];

/** Default byte budget for EACH of the two tile-level caches. Sized to hold a
 *  full tile grid for a large (roughly 4000x4000) document, so the common case
 *  keeps the old unbounded behaviour verbatim while a pathological canvas can
 *  no longer grow without limit. Hosts with a tighter ceiling pass their own. */
export const DEFAULT_TILE_CACHE_BYTES = 64 * 1024 * 1024;

/** Stateful tile-incremental compositor. composite() is byte-identical to
 *  render(doc); applyOp recomputes only tiles covering the op's dirty rect.
 *
 *  Active-layer below-checkpoint: per tile it caches the accumulator of layers
 *  `[0, A)` (A = the active/edited layer's top-level index). Re-editing the same
 *  layer reuses that checkpoint and replays only `[A, N)` per frame. The cache is
 *  discarded whenever the active layer changes or anything at/below A changes
 *  (`A' !== #activeIndex`), so a tile is never composited over a stale below —
 *  `foldRange`'s proven parity does the rest, keeping output byte-identical. */
export class IncrementalCompositor {
  #doc: PsdDoc;
  readonly #tileSize: number;
  readonly #ctx?: RenderCtx;
  // Both caches are byte-bounded. They used to be plain unbounded Maps, which
  // is fine for one screenful in a browser tab but not somewhere with a hard
  // memory ceiling: a full tile grid is W*H*4 bytes of finished tiles plus as
  // much again in checkpoints (56 MB for a 3556x2000 document, and unbounded
  // as canvases grow). Everything in them is reconstructible, so evicting is
  // purely a speed/memory trade — see `ByteLru`.
  readonly #cache: ByteLru<Pixels>;
  // Per-tile accumulator of layers [0, #activeIndex), sized to the tile region.
  readonly #belowChk: ByteLru<Uint8ClampedArray>;
  #activeIndex = 0;
  #belowRebuilds = 0;

  constructor(doc: PsdDoc, opts: { tileSize?: number; ctx?: RenderCtx; tileCacheBytes?: number; checkpointBytes?: number } = {}) {
    this.#doc = doc;
    this.#tileSize = opts.tileSize ?? 256;
    this.#ctx = opts.ctx;
    this.#cache = new ByteLru(opts.tileCacheBytes ?? DEFAULT_TILE_CACHE_BYTES, (p) => p.data.length);
    this.#belowChk = new ByteLru(opts.checkpointBytes ?? DEFAULT_TILE_CACHE_BYTES, (b) => b.length);
    this.#cachedW = doc.canvas.width;
    this.#cachedH = doc.canvas.height;
  }

  /** Bytes currently held by the finished-tile and checkpoint caches. Exposed
   *  so a memory-constrained host (an Editor DO) can observe its own footprint
   *  instead of inferring it. */
  get cacheBytes(): { tiles: number; checkpoints: number } {
    return { tiles: this.#cache.sizeBytes, checkpoints: this.#belowChk.sizeBytes };
  }

  get doc(): PsdDoc { return this.#doc; }
  get tileSize(): number { return this.#tileSize; }
  /** Test-observable count of below-checkpoint (`fold[0, A)`) builds. Stable
   *  across edits to the same active layer; grows when the checkpoint is rebuilt. */
  get _belowRebuilds(): number { return this.#belowRebuilds; }

  /** Swaps the resident document for `newDoc`, discarding all tile-level and
   *  below-checkpoint state (both are keyed to the OLD doc's layer stack and
   *  are stale for the new one). Deliberately does NOT touch `#ctx` — the
   *  same `store` + `PixelCache` carry over, so a layer whose `PixelRef`
   *  hash is unchanged between the old and new doc is served from the warm
   *  decoded-pixel cache instead of being re-fetched/re-decoded. This is
   *  what makes a 409/agent rebase in the browser cheap: only genuinely new
   *  or changed layer blobs get faulted in on the next composite/applyOp. */
  reset(newDoc: PsdDoc): void {
    this.#doc = newDoc;
    this.#cache.clear();
    this.#belowChk.clear();
    this.#activeIndex = 0;
    this.#cachedW = newDoc.canvas.width;
    this.#cachedH = newDoc.canvas.height;
  }

  async applyOp(op: PsdOp): Promise<Rect> {
    const next = applyOne(this.#doc, op);
    const dirty = opDirtyRect(op, this.#doc, next);
    const activeNext = opActiveIndex(op, this.#doc, next);
    this.#doc = next;
    // A canvas-size change (crop/init) can change the tile grid — drop
    // everything (finished tiles AND checkpoints).
    if (this.#cacheGridMismatch(next)) {
      this.#cache.clear();
      this.#belowChk.clear();
      this.#activeIndex = activeNext;
      return dirty;
    }
    // Active layer changed, or something at/below A changed → the cached
    // `fold[0, A)` may be stale; discard all checkpoints and re-anchor A.
    if (activeNext !== this.#activeIndex || activeNext < this.#activeIndex) {
      this.#belowChk.clear();
      this.#activeIndex = activeNext;
    }
    // Tile-level invalidation of finished tiles is still driven by the dirty rect.
    for (const t of tilesForRect(next.canvas, this.#tileSize, dirty)) this.#cache.delete(tileKey(t.tx, t.ty));
    return dirty;
  }

  async readTile(tx: number, ty: number): Promise<Pixels> {
    const key = tileKey(tx, ty);
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const region = tileRegion(this.#doc.canvas, this.#tileSize, tx, ty);
    const [top, left, bottom, right] = region;
    const w = right - left, h = bottom - top;
    const N = this.#doc.layers.length;
    const a = Math.max(0, Math.min(this.#activeIndex, N));
    const targetOf = (data: Uint8ClampedArray): Target => ({ data, originX: left, originY: top, width: w, height: h });

    // Below-checkpoint: acc of layers [0, a). Build (and count) on miss.
    let below = this.#belowChk.get(key);
    if (!below) {
      below = new Uint8ClampedArray(w * h * 4);
      await foldRange(targetOf(below), this.#doc, 0, a, this.#ctx);
      this.#belowChk.set(key, below);
      this.#belowRebuilds++;
    }
    // Finished tile = checkpoint copy with layers [a, N) folded on top. This
    // equals foldRange(zero, doc, 0, N) == renderRegionDirect(doc, region).
    const out = new Uint8ClampedArray(below);
    await foldRange(targetOf(out), this.#doc, a, N, this.#ctx);
    const px: Pixels = { width: w, height: h, data: out };
    this.#cache.set(key, px);
    return px;
  }

  /** Warms the persistent PixelCache with EVERY lazy layer/mask blob in the
   *  document, fetched+decoded CONCURRENTLY via `Promise.all`, before any tile
   *  is composited. Without this, the first `composite()`/`readTile()` faults
   *  layers in one at a time (`resolvePixels` is awaited per layer inside
   *  `renderList`), so cold start costs (#tiles × #layers) SERIAL round-trips
   *  to the BlobStore. Calling `prefetch()` once at init turns that into ONE
   *  parallel batch; every later composite is then a pure cache hit (CPU-only,
   *  no network), so a queued `applyOp` no longer waits behind serial faults.
   *  No-op for a resident-only doc (no PixelRefs) or when `ctx` was never
   *  supplied (nothing to prefetch into). Returns the count of unique blobs
   *  fetched (0 in the no-op case), so callers can log prefetch coverage. */
  async prefetch(): Promise<number> {
    if (!this.#ctx) return 0;
    const { store, cache } = this.#ctx;
    const refs: PixelRef[] = [];
    const walk = (layers: Layer[]): void => {
      for (const l of layers) {
        if (l.pixels && isRef(l.pixels)) refs.push(l.pixels);
        if (l.mask?.pixels && isRef(l.mask.pixels)) refs.push(l.mask.pixels);
        if (l.children) walk(l.children);
      }
    };
    walk(this.#doc.layers);
    // Dedup by content hash — the same blob (e.g. a duplicated layer, or a
    // mask sharing a layer's pixels) must not be fetched twice.
    const seen = new Set<string>();
    const unique = refs.filter((r) => (seen.has(r.hash) ? false : (seen.add(r.hash), true)));
    await Promise.all(unique.map((r) => resolvePixels(r, store, cache)));
    return unique.length;
  }

  async composite(): Promise<Pixels> {
    const { width: W, height: H } = this.#doc.canvas;
    const out = new Uint8ClampedArray(W * H * 4);
    for (const t of allTiles(this.#doc.canvas, this.#tileSize)) {
      const px = await this.readTile(t.tx, t.ty);
      const [top, left, , ] = t.region;
      for (let y = 0; y < px.height; y++) {
        const dst = ((top + y) * W + left) * 4;
        out.set(px.data.subarray(y * px.width * 4, (y + 1) * px.width * 4), dst);
      }
    }
    return { width: W, height: H, data: out };
  }

  // A cheap guard: if the cached tiles were built for a different canvas size,
  // the grid differs — clear. (Only crop/init change canvas dims.)
  #cachedW?: number; #cachedH?: number;
  #cacheGridMismatch(next: PsdDoc): boolean {
    const changed = this.#cachedW !== undefined && (this.#cachedW !== next.canvas.width || this.#cachedH !== next.canvas.height);
    this.#cachedW = next.canvas.width; this.#cachedH = next.canvas.height;
    return changed;
  }
}
