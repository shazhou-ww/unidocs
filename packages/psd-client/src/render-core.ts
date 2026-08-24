import type { BlobStore, Pixels, PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";
import { DEFAULT_CACHE_BYTES, IncrementalCompositor, PixelCache } from "@unidocs/doctype-psd/engine";

/** Worker-agnostic render core: holds ONE persistent `IncrementalCompositor`
 *  (and its `PixelCache`) over a `BlobStore`. Built once per document; after
 *  the first frame, editing a layer only re-composites the dirty tiles from
 *  already-decoded pixels — no per-edit re-fetch from the store. This is the
 *  invariant the server render path fails to hold (it rebuilds fresh state
 *  per request), so RenderCore exists to make it hold in the browser. */
export class RenderCore {
  private readonly compositor: IncrementalCompositor;

  constructor(doc: PsdDoc, store: BlobStore, opts: { tileSize?: number; cacheBytes?: number } = {}) {
    this.compositor = new IncrementalCompositor(doc, {
      tileSize: opts.tileSize,
      ctx: { store, cache: new PixelCache(opts.cacheBytes ?? DEFAULT_CACHE_BYTES) },
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
}
