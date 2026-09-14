/**
 * Opaque list cursors.
 *
 * The contract says a cursor is opaque and bounded (TENANT_LIMITS.cursor is
 * 1024), so callers must never parse one: `CursorKey` is just an `(at, id)`
 * pair, and what that pair *means* belongs entirely to the list that issued
 * it, not to this module. Two of the four tenant lists page by
 * `(created_at DESC, id DESC)` (documents, threads); `version-repository.ts`
 * pages versions by `version_idx ASC` (birth order), reusing this shape with
 * `at` holding the version index and `id` redundantly holding the same value
 * as a string, only to satisfy `decodeCursor`'s non-empty-id requirement;
 * `catalog-repository.ts` pages the catalog by `document_type DESC`, with
 * `at` fixed at `0` and `id` holding the document type. Because the encoding
 * carries no tag for which list produced it, a cursor from one list fed to
 * another decodes without error and is silently misinterpreted as that
 * list's own keyset - see the task report for whether that is worth a kind
 * tag in a later slice.
 *
 * Decoding returns null instead of throwing: a malformed cursor is a client
 * mistake the service layer reports as invalid_request, not an exception.
 */
export interface CursorKey {
  /** Meaning is the calling list's: epoch seconds for most lists, a raw index for versions, or unused (0) for the catalog. */
  readonly at: number;
  readonly id: string;
}

/**
 * Default page size when a caller omits `limit`. `PaginationQuerySchema`
 * (packages/protocol-tenant-portal/src/schemas.ts) bounds `limit` to 1..100
 * but declares no default of its own, so every tenant list repository picks
 * this same number via `query.limit ?? DEFAULT_PAGE_LIMIT`.
 */
export const DEFAULT_PAGE_LIMIT = 25;

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
