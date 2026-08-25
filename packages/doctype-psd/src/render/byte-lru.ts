/**
 * A byte-budget-bounded LRU map, the same shape of bound `PixelCache` puts on
 * decoded layer pixels — capacity in BYTES, not entries, because the values
 * here (composited tiles, per-tile checkpoints) vary by orders of magnitude
 * with tile size and an entry count would bound nothing real.
 *
 * Every value it holds is reconstructible: a missing tile is re-composited, a
 * missing checkpoint is re-folded. So eviction is only ever a cost, never a
 * correctness question — which is what makes an LRU the right structure and
 * lets callers pick a budget purely from the memory they have.
 */
export class ByteLru<V> {
  readonly #maxBytes: number;
  readonly #sizeOf: (value: V) => number;
  readonly #map = new Map<string, V>();
  #bytes = 0;

  constructor(maxBytes: number, sizeOf: (value: V) => number) {
    this.#maxBytes = maxBytes;
    this.#sizeOf = sizeOf;
  }

  /** Total bytes currently held (sum of `sizeOf` across entries). */
  get sizeBytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: string): V | undefined {
    const hit = this.#map.get(key);
    if (hit === undefined) return undefined;
    // Refresh recency: re-insert so it becomes most-recently-used.
    this.#map.delete(key);
    this.#map.set(key, hit);
    return hit;
  }

  set(key: string, value: V): void {
    const existing = this.#map.get(key);
    if (existing !== undefined) {
      this.#bytes -= this.#sizeOf(existing);
      this.#map.delete(key);
    }
    this.#map.set(key, value);
    this.#bytes += this.#sizeOf(value);
    // Evict least-recently-used until inside budget, but never the entry just
    // inserted — the caller is about to use it. A single oversized entry (a
    // tile larger than the whole budget) is therefore allowed to exceed it
    // rather than be dropped, mirroring `PixelCache`.
    while (this.#bytes > this.#maxBytes && this.#map.size > 1) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      const victim = this.#map.get(oldest)!;
      this.#map.delete(oldest);
      this.#bytes -= this.#sizeOf(victim);
    }
  }

  delete(key: string): void {
    const existing = this.#map.get(key);
    if (existing === undefined) return;
    this.#bytes -= this.#sizeOf(existing);
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
    this.#bytes = 0;
  }
}
