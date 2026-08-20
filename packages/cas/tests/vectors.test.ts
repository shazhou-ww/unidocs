/**
 * CAS kernel tests — Phase 2: remaining test vectors (9-13) + edge cases.
 *
 * Test vectors from docs/cas-binary-format.md §15.
 */

import { describe, expect, it } from "vitest";
import {
  HEADER_SIZE,
  HASH_SIZE,
  MAX_CONTENT_TYPE_LENGTH,
  encodeHeader,
  decodeHeader,
  concatenateNodeBytes,
  parseNodeBytes,
  computeNodeDigest,
  hashToHex,
  hexToHash,
  sha256,
  validateHash,
  validateContentType,
  validateDecodedHeader,
  validateChildRefs,
  validateContentLength,
} from "../src/index.js";

const textEncoder = new TextEncoder();

/** Helper: build a complete node and compute its digest. */
async function buildNode(
  contentType: string,
  content: Uint8Array,
  childHashes: Uint8Array[] = [],
) {
  const header = encodeHeader(content.length, contentType, childHashes.length);
  const contentTypeBytes = textEncoder.encode(contentType);
  const nodeBytes = concatenateNodeBytes(header, contentTypeBytes, childHashes, content);
  const digest = await computeNodeDigest(header, contentType, childHashes, content);
  return { header, contentTypeBytes, childHashes, content, nodeBytes, digest, hex: hashToHex(digest) };
}

// ─── Test Vector 9: malformed signature/version/flags/reserved ───

describe("test vector 9: malformed header fields", () => {
  it("rejects bad signature byte 0", () => {
    const header = encodeHeader(0, "text/plain", 0);
    header[0] = 0x00;
    const decoded = decodeHeader(header);
    expect(() => validateDecodedHeader(decoded)).toThrow("signature");
  });

  it("rejects bad signature byte 1", () => {
    const header = encodeHeader(0, "text/plain", 0);
    header[1] = 0x00;
    const decoded = decodeHeader(header);
    expect(() => validateDecodedHeader(decoded)).toThrow("signature");
  });

  it("rejects version 0", () => {
    const header = encodeHeader(0, "text/plain", 0);
    const view = new DataView(header.buffer);
    view.setUint16(2, 0, true);
    const decoded = decodeHeader(header);
    expect(() => validateDecodedHeader(decoded)).toThrow("version");
  });

  it("rejects version 2", () => {
    const header = encodeHeader(0, "text/plain", 0);
    const view = new DataView(header.buffer);
    view.setUint16(2, 2, true);
    const decoded = decodeHeader(header);
    expect(() => validateDecodedHeader(decoded)).toThrow("version");
  });

  it("rejects non-zero flags", () => {
    const header = encodeHeader(0, "text/plain", 0);
    const view = new DataView(header.buffer);
    view.setUint32(4, 1, true);
    const decoded = decodeHeader(header);
    expect(() => validateDecodedHeader(decoded)).toThrow("Flags");
  });

  it("rejects non-zero reserved", () => {
    const header = encodeHeader(0, "text/plain", 0);
    const view = new DataView(header.buffer);
    view.setUint16(22, 1, true);
    const decoded = decodeHeader(header);
    expect(() => validateDecodedHeader(decoded)).toThrow("Reserved");
  });

  it("rejects zero-byte content type length", () => {
    const header = encodeHeader(0, "", 0);
    const decoded = decodeHeader(header);
    expect(() => validateDecodedHeader(decoded)).toThrow("Content type length");
  });

  it("rejects wrong-size header", () => {
    expect(() => decodeHeader(new Uint8Array(10))).toThrow("24 bytes");
  });
});

// ─── Test Vector 10: content length mismatch ───

describe("test vector 10: content length mismatch", () => {
  it("validateContentLength rejects mismatch", () => {
    expect(() => validateContentLength(99, 100)).toThrow("mismatch");
  });

  it("parseNodeBytes rejects when node bytes are truncated", () => {
    const header = encodeHeader(100, "text/plain", 0);
    const contentTypeBytes = textEncoder.encode("text/plain");
    // Build correct node
    const content = new Uint8Array(100);
    content.fill(0x42);
    const nodeBytes = concatenateNodeBytes(header, contentTypeBytes, [], content);
    // Truncate the node bytes
    const truncated = nodeBytes.slice(0, nodeBytes.length - 50);
    expect(() => parseNodeBytes(truncated)).toThrow("mismatch");
  });
});

// ─── Test Vector 11: digest mismatch ───

describe("test vector 11: digest mismatch", () => {
  it("different content produces different digest", async () => {
    const a = await buildNode("text/plain", textEncoder.encode("hello"));
    const b = await buildNode("text/plain", textEncoder.encode("world"));
    expect(a.hex).not.toBe(b.hex);
  });

  it("tampered content changes digest", async () => {
    const node = await buildNode("text/plain", textEncoder.encode("original"));
    const tampered = await buildNode("text/plain", textEncoder.encode("tampered"));
    expect(node.hex).not.toBe(tampered.hex);
  });

  it("tampered metadata changes digest", async () => {
    const content = textEncoder.encode("same");
    const a = await buildNode("text/plain", content);
    const b = await buildNode("text/html", content);
    expect(a.hex).not.toBe(b.hex);
  });
});

// ─── Test Vector 12: D1 metadata + R2 content reconstructing portable digest ───

describe("test vector 12: D1 metadata + R2 content reconstruct full-node digest", () => {
  it("reconstructed digest matches original", async () => {
    const child = await buildNode("text/plain", textEncoder.encode("child-data"));
    const content = textEncoder.encode("parent-content-bytes");
    const node = await buildNode("application/json", content, [child.digest]);

    // Parse the node bytes back
    const parsed = parseNodeBytes(node.nodeBytes);

    // Reconstruct from parsed components
    const reconstructedHeader = encodeHeader(
      parsed.content.length,
      parsed.contentType,
      parsed.childHashes.length,
    );
    const reconstructedContentType = textEncoder.encode(parsed.contentType);
    const reconstructedBytes = concatenateNodeBytes(
      reconstructedHeader,
      reconstructedContentType,
      parsed.childHashes,
      parsed.content,
    );

    // Digest of reconstructed should match original
    const reconstructedDigest = await sha256(reconstructedBytes);
    expect(hashToHex(reconstructedDigest)).toBe(node.hex);
  });

  it("D1 metadata fields match header fields", async () => {
    const content = textEncoder.encode("test-content");
    const node = await buildNode("image/png", content);
    const parsed = parseNodeBytes(node.nodeBytes);
    const decoded = decodeHeader(node.header);

    expect(parsed.contentType).toBe("image/png");
    expect(parsed.content.length).toBe(decoded.contentSize);
    expect(parsed.childHashes.length).toBe(decoded.refCount);
    expect(textEncoder.encode(parsed.contentType).length).toBe(decoded.contentTypeLength);
  });
});

// ─── Test Vector 13: node whose content exceeds 1 MiB ───

describe("test vector 13: large node (> 1 MiB content)", () => {
  it("handles 1.5 MiB content without chunking", async () => {
    const size = 1.5 * 1024 * 1024; // 1.5 MiB
    const content = new Uint8Array(size);
    // Fill with a pattern for reproducibility
    for (let i = 0; i < size; i++) {
      content[i] = i & 0xff;
    }

    const node = await buildNode("application/octet-stream", content);
    expect(node.hex).toHaveLength(64);
    expect(node.hex).toMatch(/^[0-9a-f]{64}$/);

    // Verify round-trip
    const parsed = parseNodeBytes(node.nodeBytes);
    expect(parsed.content.length).toBe(size);
    expect(parsed.content[0]).toBe(0);
    expect(parsed.content[255]).toBe(255);
    expect(parsed.content[size - 1]).toBe((size - 1) & 0xff);
  });

  it("large node digest is deterministic", async () => {
    const size = 1024 * 1024 + 1; // 1 MiB + 1 byte
    const content = new Uint8Array(size);
    content.fill(0xab);

    const a = await buildNode("application/octet-stream", content);
    const b = await buildNode("application/octet-stream", content);
    expect(a.hex).toBe(b.hex);
  });
});

// ─── Edge cases ───

describe("edge cases", () => {
  it("content type with spaces", async () => {
    const node = await buildNode("text/plain; charset=utf-8", textEncoder.encode("hi"));
    expect(node.hex).toHaveLength(64);
  });

  it("binary content with all byte values", async () => {
    const content = new Uint8Array(256);
    for (let i = 0; i < 256; i++) content[i] = i;
    const node = await buildNode("application/octet-stream", content);
    expect(node.hex).toHaveLength(64);

    const parsed = parseNodeBytes(node.nodeBytes);
    expect(parsed.content).toEqual(content);
  });

  it("node with many child refs", async () => {
    const children: Uint8Array[] = [];
    for (let i = 0; i < 10; i++) {
      const child = await buildNode("text/plain", textEncoder.encode(`child-${i}`));
      children.push(child.digest);
    }
    const parent = await buildNode("application/json", textEncoder.encode("{}"), children);
    expect(parent.hex).toHaveLength(64);

    const parsed = parseNodeBytes(parent.nodeBytes);
    expect(parsed.childHashes).toHaveLength(10);
  });

  it("empty refs array produces valid node", async () => {
    const node = await buildNode("text/plain", textEncoder.encode("no refs"), []);
    expect(node.hex).toHaveLength(64);
    const parsed = parseNodeBytes(node.nodeBytes);
    expect(parsed.childHashes).toHaveLength(0);
  });

  it("single-byte content type", async () => {
    const node = await buildNode("x", textEncoder.encode("minimal"));
    expect(node.hex).toHaveLength(64);
    const parsed = parseNodeBytes(node.nodeBytes);
    expect(parsed.contentType).toBe("x");
  });

  it("single-byte content", async () => {
    const node = await buildNode("text/plain", new Uint8Array([0x42]));
    expect(node.hex).toHaveLength(64);
    const parsed = parseNodeBytes(node.nodeBytes);
    expect(parsed.content).toEqual(new Uint8Array([0x42]));
  });

  it("zero refs + zero content is valid", async () => {
    const node = await buildNode("text/plain", new Uint8Array(0), []);
    expect(node.hex).toHaveLength(64);
    const decoded = decodeHeader(node.header);
    expect(decoded.contentSize).toBe(0);
    expect(decoded.refCount).toBe(0);
  });
});

// ─── Hex conversion edge cases ───

describe("hex conversion edge cases", () => {
  it("all-zero hash", () => {
    const hex = "0".repeat(64);
    expect(() => validateHash(hex)).not.toThrow();
    const raw = hexToHash(hex);
    expect(raw.every((b) => b === 0)).toBe(true);
    expect(hashToHex(raw)).toBe(hex);
  });

  it("all-ff hash", () => {
    const hex = "f".repeat(64);
    expect(() => validateHash(hex)).not.toThrow();
    const raw = hexToHash(hex);
    expect(raw.every((b) => b === 0xff)).toBe(true);
    expect(hashToHex(raw)).toBe(hex);
  });

  it("rejects uppercase in hexToHash", () => {
    // hexToHash uses parseInt which accepts uppercase, but we should
    // validate the format separately
    expect(() => validateHash("A".repeat(64))).toThrow("lowercase");
  });
});

// ─── Streaming vs one-shot digest consistency ───

describe("digest consistency", () => {
  it("computeNodeDigest matches manual sha256 of concatenated bytes", async () => {
    const content = textEncoder.encode("consistency check");
    const child = await buildNode("text/plain", textEncoder.encode("dep"));

    const header = encodeHeader(content.length, "text/plain", 1);
    const contentTypeBytes = textEncoder.encode("text/plain");
    const nodeBytes = concatenateNodeBytes(header, contentTypeBytes, [child.digest], content);

    // One-shot SHA-256 of the full node bytes
    const oneShot = await sha256(nodeBytes);
    const oneShotHex = hashToHex(oneShot);

    // Via computeNodeDigest
    const streaming = await computeNodeDigest(header, "text/plain", [child.digest], content);
    const streamingHex = hashToHex(streaming);

    expect(streamingHex).toBe(oneShotHex);
  });
});
