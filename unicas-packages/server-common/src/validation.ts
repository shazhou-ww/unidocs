/**
 * CAS validation rules.
 *
 * Pure validation functions with no I/O.
 */

import {
  HEADER_SIZE,
  HASH_HEX_LENGTH,
  HASH_SIZE,
  MAX_CONTENT_TYPE_LENGTH,
  MIN_CONTENT_TYPE_LENGTH,
  VERSION,
  decodeHeader,
} from "./binary.js";

const HASH_HEX_RE = /^[0-9a-f]{64}$/;
const CONTENT_TYPE_RE = /^[\x20-\x7e]+$/;

export const MAX_CANONICAL_NODE_BYTES = 64 * 1024 * 1024;
export const MAX_NODE_REFS = 256;

export interface CanonicalNodeLimits {
  readonly maxCanonicalNodeBytes?: number;
  readonly maxNodeRefs?: number;
}

/** Return the canonical byte length after enforcing version-1 resource limits. */
export function validateCanonicalNodeSize(
  contentSize: number,
  contentTypeLength: number,
  refCount: number,
  limits: CanonicalNodeLimits = {},
): number {
  const maxCanonicalNodeBytes = resolveLimit(
    limits.maxCanonicalNodeBytes,
    MAX_CANONICAL_NODE_BYTES,
    "Canonical node byte limit",
  );
  const maxNodeRefs = resolveLimit(limits.maxNodeRefs, MAX_NODE_REFS, "Child ref limit", true);
  if (!Number.isSafeInteger(contentSize) || contentSize < 0) {
    throw new Error(`Invalid content size: ${contentSize}`);
  }
  if (
    !Number.isSafeInteger(contentTypeLength)
    || contentTypeLength < MIN_CONTENT_TYPE_LENGTH
    || contentTypeLength > MAX_CONTENT_TYPE_LENGTH
  ) {
    throw new Error(`Content type length out of range: ${contentTypeLength}`);
  }
  if (!Number.isSafeInteger(refCount) || refCount < 0 || refCount > maxNodeRefs) {
    throw new Error(`Child ref count out of range: ${refCount}`);
  }

  const totalLength = HEADER_SIZE + contentTypeLength + refCount * HASH_SIZE + contentSize;
  if (!Number.isSafeInteger(totalLength)) {
    throw new Error("Total node length overflows safe integer range");
  }
  if (totalLength > maxCanonicalNodeBytes) {
    throw new Error(`Canonical node too large: ${totalLength} > ${maxCanonicalNodeBytes}`);
  }
  return totalLength;
}

function resolveLimit(value: number | undefined, maximum: number, name: string, allowZero = false): number {
  if (value === undefined) return maximum;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

/** Validate a CAS hash string (64 lowercase hex chars). */
export function validateHash(hash: string): void {
  if (hash.length !== HASH_HEX_LENGTH) {
    throw new Error(
      `Hash must be ${HASH_HEX_LENGTH} characters, got ${hash.length}`,
    );
  }
  if (!HASH_HEX_RE.test(hash)) {
    throw new Error(`Hash must be lowercase hex: ${hash}`);
  }
}

/** Validate a raw 32-byte hash. */
export function validateRawHash(raw: Uint8Array): void {
  if (raw.length !== HASH_SIZE) {
    throw new Error(`Raw hash must be ${HASH_SIZE} bytes, got ${raw.length}`);
  }
}

/** Validate a content type string. */
export function validateContentType(contentType: string): void {
  const bytes = new TextEncoder().encode(contentType);
  if (bytes.length < MIN_CONTENT_TYPE_LENGTH) {
    throw new Error("Content type must not be empty");
  }
  if (bytes.length > MAX_CONTENT_TYPE_LENGTH) {
    throw new Error(
      `Content type too long: ${bytes.length} > ${MAX_CONTENT_TYPE_LENGTH}`,
    );
  }
  if (contentType.includes("\0")) {
    throw new Error("Content type must not contain NUL");
  }
  if (!CONTENT_TYPE_RE.test(contentType)) {
    throw new Error(
      `Content type must be printable ASCII (0x20-0x7e): ${contentType}`,
    );
  }
}

/** Validate a decoded header (version 1 rules). */
export function validateDecodedHeader(decoded: ReturnType<typeof decodeHeader>): void {
  // Signature
  if (decoded.signature[0] !== 0x55 || decoded.signature[1] !== 0x44) {
    throw new Error("Invalid signature: expected 'UD'");
  }

  // Version
  if (decoded.version !== VERSION) {
    throw new Error(`Unsupported version: ${decoded.version} (expected ${VERSION})`);
  }

  // Flags must be zero
  if (decoded.flags !== 0) {
    throw new Error(`Flags must be zero, got ${decoded.flags}`);
  }

  // Reserved must be zero
  if (decoded.reserved !== 0) {
    throw new Error(`Reserved must be zero, got ${decoded.reserved}`);
  }

  validateCanonicalNodeSize(
    decoded.contentSize,
    decoded.contentTypeLength,
    decoded.refCount,
  );
}

/**
 * Validate a complete set of child refs.
 *
 * @param refs - Array of hash strings.
 * @param refCount - Expected count from header.
 */
export function validateChildRefs(
  refs: readonly string[],
  refCount: number,
): void {
  if (refs.length !== refCount) {
    throw new Error(
      `Child ref count mismatch: header says ${refCount}, got ${refs.length}`,
    );
  }
  for (const ref of refs) {
    validateHash(ref);
  }
}

/** Validate content length matches descriptor. */
export function validateContentLength(
  actualLength: number,
  expectedLength: number,
): void {
  if (actualLength !== expectedLength) {
    throw new Error(
      `Content length mismatch: expected ${expectedLength}, got ${actualLength}`,
    );
  }
}
