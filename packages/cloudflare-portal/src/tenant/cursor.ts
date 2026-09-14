/**
 * Opaque list cursors.
 *
 * The contract says a cursor is opaque and bounded (TENANT_LIMITS.cursor is
 * 1024), so callers must never parse one. Every tenant list orders by
 * (created_at DESC, id DESC); the cursor is simply the last row's pair, which
 * makes paging a keyset comparison rather than an OFFSET scan.
 *
 * Decoding returns null instead of throwing: a malformed cursor is a client
 * mistake the service layer reports as invalid_request, not an exception.
 */
export interface CursorKey {
  /** Epoch seconds, matching the INTEGER timestamps in the tenant tables. */
  readonly at: number;
  readonly id: string;
}

const MAX_CURSOR_LENGTH = 1_024;

export function encodeCursor(key: CursorKey): string {
  const json = JSON.stringify([key.at, key.id]);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeCursor(cursor: string): CursorKey | null {
  if (!cursor || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let parsed: unknown;
  try {
    const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [at, id] = parsed;
  if (!Number.isSafeInteger(at) || (at as number) < 0 || typeof id !== "string" || !id) return null;
  return { at: at as number, id };
}
