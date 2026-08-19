/**
 * CAS binary format.
 *
 * Canonical header encoding/decoding and layout parsing.
 *
 * Header layout (24 bytes, all multi-byte integers are little-endian):
 *   Offset  Size  Field               Type     Version 1 value
 *   0       2     signature           bytes    55 44 ("UD")
 *   2       2     version             u16 LE   1
 *   4       4     flags               u32 LE   0
 *   8       8     contentSize         u64 LE   own R2 content byte length
 *   16      4     refCount            u32 LE   ordered child hash count
 *   20      2     contentTypeLength   u16 LE   UTF-8 content type byte length
 *   22      2     reserved            u16 LE   0
 *
 * Canonical layout (no padding):
 *   header (24 bytes)
 *   + contentType (contentTypeLength bytes, UTF-8)
 *   + childHashes (refCount * 32 bytes, raw SHA-256)
 *   + ownContent (contentSize bytes)
 */

/** Header size in bytes. */
export const HEADER_SIZE = 24;

/** Signature bytes: "UD". */
export const SIGNATURE = new Uint8Array([0x55, 0x44]);

/** Current format version. */
export const VERSION = 1;

/** Maximum content type length in bytes (version 1). */
export const MAX_CONTENT_TYPE_LENGTH = 1024;

/** Minimum content type length. */
export const MIN_CONTENT_TYPE_LENGTH = 1;

/** Size of a raw SHA-256 hash in bytes. */
export const HASH_SIZE = 32;

/** Size of a hex-encoded SHA-256 hash in characters. */
export const HASH_HEX_LENGTH = 64;

/**
 * Encode a canonical header.
 *
 * @param contentSize - Byte length of own content.
 * @param contentType - UTF-8 content type string.
 * @param refCount - Number of ordered child references.
 * @returns 24-byte header as Uint8Array.
 */
export function encodeHeader(
  contentSize: number,
  contentType: string,
  refCount: number,
): Uint8Array {
  const contentTypeBytes = new TextEncoder().encode(contentType);
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);

  // Signature
  header[0] = SIGNATURE[0];
  header[1] = SIGNATURE[1];

  // Version (u16 LE)
  view.setUint16(2, VERSION, true);

  // Flags (u32 LE) = 0
  view.setUint32(4, 0, true);

  // Content size (u64 LE)
  view.setBigUint64(8, BigInt(contentSize), true);

  // Ref count (u32 LE)
  view.setUint32(16, refCount, true);

  // Content type length (u16 LE)
  view.setUint16(20, contentTypeBytes.length, true);

  // Reserved (u16 LE) = 0
  view.setUint16(22, 0, true);

  return header;
}

/**
 * Decode a canonical header.
 *
 * @param header - 24-byte header.
 * @returns Parsed header fields.
 * @throws Error if header is malformed.
 */
export function decodeHeader(header: Uint8Array): {
  signature: Uint8Array;
  version: number;
  flags: number;
  contentSize: number;
  refCount: number;
  contentTypeLength: number;
  reserved: number;
} {
  if (header.length !== HEADER_SIZE) {
    throw new Error(`Header must be ${HEADER_SIZE} bytes, got ${header.length}`);
  }

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

  return {
    signature: header.slice(0, 2),
    version: view.getUint16(2, true),
    flags: view.getUint32(4, true),
    contentSize: Number(view.getBigUint64(8, true)),
    refCount: view.getUint32(16, true),
    contentTypeLength: view.getUint16(20, true),
    reserved: view.getUint16(22, true),
  };
}

/**
 * Concatenate canonical logical node bytes.
 *
 * @param header - 24-byte header.
 * @param contentType - UTF-8 content type.
 * @param childHashes - Ordered raw 32-byte hashes.
 * @param content - Own content bytes.
 * @returns Complete canonical node bytes.
 */
export function concatenateNodeBytes(
  header: Uint8Array,
  contentType: Uint8Array,
  childHashes: Uint8Array[],
  content: Uint8Array,
): Uint8Array {
  const totalSize =
    HEADER_SIZE +
    contentType.length +
    childHashes.length * HASH_SIZE +
    content.length;

  const result = new Uint8Array(totalSize);
  let offset = 0;

  result.set(header, offset);
  offset += HEADER_SIZE;

  result.set(contentType, offset);
  offset += contentType.length;

  for (const hash of childHashes) {
    result.set(hash, offset);
    offset += HASH_SIZE;
  }

  result.set(content, offset);

  return result;
}

/**
 * Parse canonical logical node bytes.
 *
 * @param bytes - Complete canonical node bytes.
 * @returns Parsed components.
 * @throws Error if bytes are malformed.
 */
export function parseNodeBytes(bytes: Uint8Array): {
  header: Uint8Array;
  contentType: string;
  childHashes: Uint8Array[];
  content: Uint8Array;
} {
  if (bytes.length < HEADER_SIZE) {
    throw new Error(`Node bytes too short: ${bytes.length} < ${HEADER_SIZE}`);
  }

  const header = bytes.slice(0, HEADER_SIZE);
  const decoded = decodeHeader(header);

  const expectedLength =
    HEADER_SIZE +
    decoded.contentTypeLength +
    decoded.refCount * HASH_SIZE +
    decoded.contentSize;

  if (bytes.length !== expectedLength) {
    throw new Error(
      `Node bytes length mismatch: expected ${expectedLength}, got ${bytes.length}`,
    );
  }

  let offset = HEADER_SIZE;

  const contentTypeBytes = bytes.slice(offset, offset + decoded.contentTypeLength);
  const contentType = new TextDecoder().decode(contentTypeBytes);
  offset += decoded.contentTypeLength;

  const childHashes: Uint8Array[] = [];
  for (let i = 0; i < decoded.refCount; i++) {
    childHashes.push(bytes.slice(offset, offset + HASH_SIZE));
    offset += HASH_SIZE;
  }

  const content = bytes.slice(offset, offset + decoded.contentSize);

  return { header, contentType, childHashes, content };
}
