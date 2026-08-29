import { decode, encode, rfc8949EncodeOptions } from "cborg";

export const BlobChunkContentType = "application/vnd.unicas.blob-chunk";
export const BlobIndexContentType = "application/vnd.unicas.blob-index+cbor;version=1";
export const BlobChunkBytes = 32 * 1024 * 1024;
export const BlobIndexFanout = 256;

export interface CasBlobIndexV1 {
  readonly version: 1;
  readonly level: number;
  readonly size: number;
  readonly mediaType: string;
  readonly children: readonly { readonly size: number }[];
}

function validateSafeSize(value: unknown, name: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) <= 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return Number(value);
}

export function validateBlobIndex(value: CasBlobIndexV1): void {
  if (value.version !== 1) throw new TypeError("Blob index version must be 1");
  validateSafeSize(value.level, "Blob index level", true);
  validateSafeSize(value.size, "Blob index size", false);
  if (!/^[\x20-\x7e]+$/.test(value.mediaType) || value.mediaType.length > 1024) {
    throw new TypeError("Blob index mediaType must be 1-1024 printable ASCII characters");
  }
  if (!Array.isArray(value.children) || value.children.length < 1 || value.children.length > BlobIndexFanout) {
    throw new TypeError(`Blob index must contain 1-${BlobIndexFanout} children`);
  }
  let total = 0;
  for (const [index, child] of value.children.entries()) {
    const size = validateSafeSize(child?.size, `Blob index child ${index} size`, false);
    total += size;
    if (!Number.isSafeInteger(total)) throw new TypeError("Blob index child sizes overflow");
  }
  if (total !== value.size) {
    throw new TypeError(`Blob index size mismatch: expected ${value.size}, got ${total}`);
  }
}

function wireValue(value: CasBlobIndexV1): Record<string, unknown> {
  return {
    v: value.version,
    l: value.level,
    s: value.size,
    m: value.mediaType,
    c: value.children.map(child => child.size),
  };
}

export function encodeBlobIndex(value: CasBlobIndexV1): Uint8Array {
  validateBlobIndex(value);
  return Uint8Array.from(encode(wireValue(value), rfc8949EncodeOptions));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function decodeBlobIndex(bytes: Uint8Array): CasBlobIndexV1 {
  const decoded = decode(bytes) as Record<string, unknown>;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("Blob index must be a CBOR map");
  }
  const keys = Object.keys(decoded).sort();
  if (keys.join(",") !== "c,l,m,s,v") {
    throw new TypeError("Blob index contains unknown or missing fields");
  }
  if (!Array.isArray(decoded.c)) throw new TypeError("Blob index children must be an array");
  const value: CasBlobIndexV1 = {
    version: decoded.v as 1,
    level: decoded.l as number,
    size: decoded.s as number,
    mediaType: decoded.m as string,
    children: decoded.c.map(size => ({ size: size as number })),
  };
  validateBlobIndex(value);
  if (!equalBytes(bytes, encodeBlobIndex(value))) {
    throw new TypeError("Blob index encoding is not canonical");
  }
  return Object.freeze({
    ...value,
    children: Object.freeze(value.children.map(child => Object.freeze(child))),
  });
}