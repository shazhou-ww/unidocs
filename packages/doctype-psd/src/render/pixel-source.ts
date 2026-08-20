import { decode } from "fast-png";
import type { Pixels } from "../model/types.js";

/** A reference to a decoded (resident) pixel buffer's PNG-encoded bytes,
 *  stored externally (e.g. blob storage) and addressed by content hash. */
export interface PixelRef {
  width: number;
  height: number;
  hash: string;
}

/** A layer's pixel data: either resident in memory, or a lazy reference
 *  to a PNG blob that must be resolved via `resolvePixels`. */
export type PixelSource = Pixels | PixelRef;

/** Narrows a PixelSource to PixelRef: has `hash`, has no `data`. */
export const isRef = (p: PixelSource): p is PixelRef =>
  "hash" in p && !("data" in (p as any));

/** Content-addressed byte storage for PNG-encoded pixel blobs. */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array | null>;
}

/** A byte-budget-bounded LRU cache of decoded Pixels, keyed by hash. Capacity
 *  is measured in decoded bytes (`pixels.data.length`), not entry count — an
 *  entry-count cap could hold arbitrarily large full-canvas layers and blow
 *  past any real memory bound. A single entry larger than the whole budget is
 *  still inserted (a render cannot refuse to hold the layer it just needs to
 *  draw) and stays resident only until the next `set` evicts it. */
export class PixelCache {
  private readonly maxBytes: number;
  private readonly map = new Map<string, Pixels>();
  private totalBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** Current total decoded bytes held in the cache (sum of `data.length`
   *  across all entries). Exposed so callers/tests can verify the byte
   *  budget is actually enforced, without reaching into private state. */
  get sizeBytes(): number {
    return this.totalBytes;
  }

  get(hash: string): Pixels | undefined {
    const hit = this.map.get(hash);
    if (hit === undefined) return undefined;
    // Refresh recency: re-insert so it becomes most-recently-used.
    this.map.delete(hash);
    this.map.set(hash, hit);
    return hit;
  }

  set(hash: string, pixels: Pixels): void {
    const existing = this.map.get(hash);
    if (existing !== undefined) {
      this.totalBytes -= existing.data.length;
      this.map.delete(hash);
    }
    this.map.set(hash, pixels);
    this.totalBytes += pixels.data.length;
    // Evict LRU entries until back within budget, but always keep the entry
    // we just inserted (it's most-recently-used, so it's evicted last) — a
    // lone oversized entry is allowed to exceed the budget rather than be
    // dropped, since it's needed for the render in progress.
    while (this.totalBytes > this.maxBytes && this.map.size > 1) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.map.get(oldestKey)!;
      this.map.delete(oldestKey);
      this.totalBytes -= oldest.data.length;
    }
  }
}

/** Resolves a PixelSource to resident Pixels: passes resident data through
 *  unchanged; for a PixelRef, serves from cache when present, otherwise
 *  fetches the PNG blob from `store`, decodes it, caches, and returns it. */
export async function resolvePixels(
  src: PixelSource,
  store: BlobStore,
  cache: PixelCache
): Promise<Pixels> {
  if (!isRef(src)) return src;

  const cached = cache.get(src.hash);
  if (cached) return cached;

  const bytes = await store.get(src.hash);
  if (bytes === null) {
    throw new Error(`PixelSource: no blob found in store for hash "${src.hash}"`);
  }

  const decoded = decode(bytes);
  const data =
    decoded.data instanceof Uint8ClampedArray
      ? decoded.data
      : new Uint8ClampedArray(
          decoded.data.buffer,
          decoded.data.byteOffset,
          decoded.data.length
        );
  const pixels: Pixels = { width: decoded.width, height: decoded.height, data };

  cache.set(src.hash, pixels);
  return pixels;
}
