import type { PsdDoc, Pixels } from "../model/types.js";
import type { PsdOp } from "../ops/index.js";
import type { RenderCtx } from "./composite.js";
import { applyOne } from "../ops/index.js";
import { renderRegionDirect } from "./region.js";
import { allTiles, tilesForRect, tileKey, tileRegion } from "./tile-grid.js";
import { opDirtyRect } from "./dirty-rect.js";

type Rect = [number, number, number, number];

/** Stateful tile-incremental compositor. composite() is byte-identical to
 *  render(doc); applyOp recomputes only tiles covering the op's dirty rect. */
export class IncrementalCompositor {
  #doc: PsdDoc;
  readonly #tileSize: number;
  readonly #ctx?: RenderCtx;
  readonly #cache = new Map<string, Pixels>();

  constructor(doc: PsdDoc, opts: { tileSize?: number; ctx?: RenderCtx } = {}) {
    this.#doc = doc;
    this.#tileSize = opts.tileSize ?? 256;
    this.#ctx = opts.ctx;
    this.#cachedW = doc.canvas.width;
    this.#cachedH = doc.canvas.height;
  }

  get doc(): PsdDoc { return this.#doc; }
  get tileSize(): number { return this.#tileSize; }

  async applyOp(op: PsdOp): Promise<Rect> {
    const next = applyOne(this.#doc, op);
    const dirty = opDirtyRect(op, this.#doc, next);
    this.#doc = next;
    // Invalidate every tile the dirty rect touches. A canvas-size change
    // (crop) can change the grid, so on size change drop the whole cache.
    if (this.#cacheGridMismatch(next)) {
      this.#cache.clear();
    } else {
      for (const t of tilesForRect(next.canvas, this.#tileSize, dirty)) this.#cache.delete(tileKey(t.tx, t.ty));
    }
    return dirty;
  }

  async readTile(tx: number, ty: number): Promise<Pixels> {
    const key = tileKey(tx, ty);
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const region = tileRegion(this.#doc.canvas, this.#tileSize, tx, ty);
    const px = await renderRegionDirect(this.#doc, region, this.#ctx);
    this.#cache.set(key, px);
    return px;
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
