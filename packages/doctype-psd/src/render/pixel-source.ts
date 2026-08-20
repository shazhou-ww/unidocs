import { decode } from "fast-png";
import type { BlobStore } from "@unidocs/core";
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
export type { BlobStore };

/** A simple entry-count-bounded LRU cache of decoded Pixels, keyed by hash. */
export class PixelCache {
  private readonly capacity: number;
  private readonly map = new Map<string, Pixels>();

  constructor(capacity: number) {
    this.capacity = capacity;
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
    if (this.map.has(hash)) this.map.delete(hash);
    this.map.set(hash, pixels);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
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
