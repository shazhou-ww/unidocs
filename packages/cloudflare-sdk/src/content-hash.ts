/**
 * Content hash used for R2 CAS keys.
 *
 * SHA-256 of the bytes, truncated to the first 8 bytes, encoded as 16
 * lowercase hex characters. Single source of truth — reused by editor-do.ts
 * (document snapshot bytes) and blob-store.ts (per-layer pixel blobs) so CAS
 * keys never diverge.
 */
export async function computeHash(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}
