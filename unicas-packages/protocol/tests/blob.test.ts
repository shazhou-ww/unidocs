import { describe, expect, test } from "vitest";
import {
  BlobChunkBytes,
  BlobIndexFanout,
  decodeBlobIndex,
  encodeBlobIndex,
} from "../src/index.js";

describe("blob index protocol", () => {
  test("uses 32 MiB chunks and 256-way indexes for 8 GiB single-level blobs", () => {
    expect(BlobChunkBytes).toBe(32 * 1024 * 1024);
    expect(BlobIndexFanout).toBe(256);
    expect(BlobChunkBytes * BlobIndexFanout).toBe(8 * 1024 * 1024 * 1024);
  });

  test("round-trips deterministic version-1 metadata", () => {
    const value = {
      version: 1 as const,
      level: 0,
      size: BlobChunkBytes + 7,
      mediaType: "application/octet-stream",
      children: [{ size: BlobChunkBytes }, { size: 7 }],
    };
    const first = encodeBlobIndex(value);
    const second = encodeBlobIndex(value);
    expect(first).toEqual(second);
    expect(decodeBlobIndex(first)).toEqual(value);
  });

  test("rejects inconsistent totals and excess fan-out", () => {
    expect(() => encodeBlobIndex({
      version: 1,
      level: 0,
      size: 2,
      mediaType: "text/plain",
      children: [{ size: 1 }],
    })).toThrow("size mismatch");
    expect(() => encodeBlobIndex({
      version: 1,
      level: 0,
      size: BlobIndexFanout + 1,
      mediaType: "text/plain",
      children: Array.from({ length: BlobIndexFanout + 1 }, () => ({ size: 1 })),
    })).toThrow(`1-${BlobIndexFanout}`);
  });

  test("rejects non-canonical CBOR", () => {
    const nonCanonical = Uint8Array.from([0xa5, 0x61, 0x76, 0x18, 0x01, 0x61, 0x6c, 0x00, 0x61, 0x73, 0x01, 0x61, 0x6d, 0x61, 0x78, 0x61, 0x63, 0x81, 0x01]);
    expect(() => decodeBlobIndex(nonCanonical)).toThrow("not canonical");
  });
});