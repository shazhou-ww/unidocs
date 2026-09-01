/**
 * Opaque versioned list cursors for control-plane pagination.
 *
 * A cursor encodes the keyset position plus the control-data snapshot
 * revision it was created under. If the snapshot revision changed since the
 * cursor was issued, the page is discarded and the caller restarts from page
 * one (`INVALID_CURSOR`).
 */

export interface ControlListCursor {
  readonly version: 1;
  readonly snapshot: number;
  /** Last sort key of the previous page. */
  readonly last: string;
}

export function encodeControlListCursor(cursor: ControlListCursor): string {
  const json = JSON.stringify(cursor);
  return btoa(json);
}

export function decodeControlListCursor(value: string): ControlListCursor | null {
  let json: string;
  try {
    json = atob(value);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== 1
    || typeof candidate.snapshot !== "number"
    || !Number.isSafeInteger(candidate.snapshot)
    || typeof candidate.last !== "string"
    || candidate.last.length === 0
  ) {
    return null;
  }
  return {
    version: 1,
    snapshot: candidate.snapshot,
    last: candidate.last,
  };
}
