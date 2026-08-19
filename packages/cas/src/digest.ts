/**
 * CAS digest computation.
 *
 * Streaming SHA-256 over canonical logical node bytes.
 * Uses Web Crypto API (available in Node 18+, Deno, Bun, Cloudflare Workers).
 */

import { HASH_SIZE } from "./binary.js";

const textEncoder = new TextEncoder();

/**
 * Compute SHA-256 digest of a byte array.
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return new Uint8Array(hashBuffer);
}

/**
 * Compute the digest of a canonical logical node.
 *
 * Computes SHA-256(header || contentTypeUtf8 || childHashes || ownContent)
 * incrementally using streaming updates.
 *
 * @param encodeHeader - Function that returns the 24-byte header.
 * @param contentType - UTF-8 content type string.
 * @param childHashes - Ordered list of raw 32-byte child hashes.
 * @param content - Own content bytes.
 * @returns Raw 32-byte SHA-256 digest.
 */
export async function computeNodeDigest(
  headerBytes: Uint8Array,
  contentType: string,
  childHashes: readonly Uint8Array[],
  content: Uint8Array,
): Promise<Uint8Array> {
  // Concatenate all canonical bytes
  const contentTypeBytes = textEncoder.encode(contentType);
  const totalSize =
    headerBytes.length +
    contentTypeBytes.length +
    childHashes.length * HASH_SIZE +
    content.length;

  const canonical = new Uint8Array(totalSize);
  let offset = 0;

  canonical.set(headerBytes, offset);
  offset += headerBytes.length;

  canonical.set(contentTypeBytes, offset);
  offset += contentTypeBytes.length;

  for (const hash of childHashes) {
    canonical.set(hash, offset);
    offset += HASH_SIZE;
  }

  canonical.set(content, offset);

  return sha256(canonical);
}

/**
 * Convert a raw 32-byte hash to lowercase hex string.
 */
export function hashToHex(hash: Uint8Array): string {
  if (hash.length !== HASH_SIZE) {
    throw new Error(`Expected ${HASH_SIZE} bytes, got ${hash.length}`);
  }
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert a hex string to raw bytes.
 */
export function hexToHash(hex: string): Uint8Array {
  if (hex.length !== HASH_SIZE * 2) {
    throw new Error(
      `Expected ${HASH_SIZE * 2} hex characters, got ${hex.length}`,
    );
  }
  const bytes = new Uint8Array(HASH_SIZE);
  for (let i = 0; i < HASH_SIZE; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
