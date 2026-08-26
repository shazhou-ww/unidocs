/**
 * Explicit root-ref delta transition for the SValue editor.
 *
 * The editor retains the current delta plus, when a snapshot exists, the
 * current snapshot. Given the previously retained roots and the roots being
 * settled, this computes a `changes` map of +1/−1 refcount adjustments
 * suitable for `CasClient.updateRootRefs`.
 *
 * Zero-sum entries are dropped: re-settling a hash that is already retained
 * (response-loss retry, byte-identical re-commit) cancels out to nothing, and
 * `updateRootRefs` rejects empty change maps entirely — callers must skip the
 * CAS call when the resulting map is empty.
 */

export interface RetainedRoots {
  /** Latest committed delta root hash, or null when no delta exists yet. */
  readonly delta: string | null;
  /** Latest committed snapshot root hash, or null when none exists yet. */
  readonly snapshot: string | null;
}

/** Roots being settled: the delta always exists; the snapshot is optional. */
export interface NextRoots {
  readonly delta: string;
  readonly snapshot: string | null;
}

/**
 * Compute +1/−1 refcount changes that move the retained set from `previous`
 * to `next`.
 *
 * The previous snapshot is only released when a new snapshot is being
 * retained — settling a snapshot-less version keeps the current snapshot
 * intact. Identical hashes produce zero-sum entries which are dropped.
 */
export function rootTransitionChanges(
  previous: RetainedRoots,
  next: NextRoots,
): Record<string, number> {
  const changes: Record<string, number> = {};
  const add = (hash: string, delta: number): void => {
    changes[hash] = (changes[hash] ?? 0) + delta;
  };

  add(next.delta, 1);
  if (previous.delta !== null) {
    add(previous.delta, -1);
  }
  if (next.snapshot !== null) {
    add(next.snapshot, 1);
    if (previous.snapshot !== null) {
      add(previous.snapshot, -1);
    }
  }

  for (const [hash, delta] of Object.entries(changes)) {
    if (delta === 0) delete changes[hash];
  }
  return changes;
}
