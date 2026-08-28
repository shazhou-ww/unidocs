/**
 * CAS kernel tests — Phase 1 test vectors (1-8 of 13).
 *
 * Test vectors from docs/cas-binary-format.md §15.
 */

import { describe, expect, it } from "vitest";
import {
  HEADER_SIZE,
  HASH_SIZE,
  MAX_CANONICAL_NODE_BYTES,
  MAX_CONTENT_TYPE_LENGTH,
  MAX_NODE_REFS,
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
  validateCanonicalNodeSize,
  parseCanonicalNodeStream,
} from "../src/index.js";

const textEncoder = new TextEncoder();

function fragmentedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

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

// ─── Test Vector 1: empty application/octet-stream node ───

describe("test vector 1: empty application/octet-stream node", () => {
  it("produces a valid digest for zero-byte content", async () => {
    const node = await buildNode("application/octet-stream", new Uint8Array(0));
    expect(node.hex).toHaveLength(64);
    expect(node.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(node.nodeBytes.length).toBe(HEADER_SIZE + "application/octet-stream".length);
  });

  it("round-trips through encode/parse", async () => {
    const node = await buildNode("application/octet-stream", new Uint8Array(0));
    const parsed = parseNodeBytes(node.nodeBytes);
    expect(parsed.contentType).toBe("application/octet-stream");
    expect(parsed.childHashes).toHaveLength(0);
    expect(parsed.content.length).toBe(0);
  });
});

// ─── Test Vector 2: small text node with no refs ───

describe("test vector 2: small text node with no refs", () => {
  it("produces a valid digest", async () => {
    const content = textEncoder.encode("Hello, CAS!");
    const node = await buildNode("text/plain", content);
    expect(node.hex).toHaveLength(64);
    expect(node.hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("round-trips through encode/parse", async () => {
    const content = textEncoder.encode("Hello, CAS!");
    const node = await buildNode("text/plain", content);
    const parsed = parseNodeBytes(node.nodeBytes);
    expect(parsed.contentType).toBe("text/plain");
    expect(parsed.childHashes).toHaveLength(0);
    expect(new TextDecoder().decode(parsed.content)).toBe("Hello, CAS!");
  });

  it("deterministic: same input produces same hash", async () => {
    const content = textEncoder.encode("Hello, CAS!");
    const a = await buildNode("text/plain", content);
    const b = await buildNode("text/plain", content);
    expect(a.hex).toBe(b.hex);
  });
});

// ─── Test Vector 3: node with one child ───

describe("test vector 3: node with one child", () => {
  it("includes child hash in digest", async () => {
    const child = await buildNode("text/plain", textEncoder.encode("child"));
    const parent = await buildNode(
      "application/json",
      textEncoder.encode('{"ref":"child"}'),
      [child.digest],
    );

    expect(parent.hex).toHaveLength(64);
    expect(parent.hex).not.toBe(child.hex);

    const parsed = parseNodeBytes(parent.nodeBytes);
    expect(parsed.childHashes).toHaveLength(1);
    expect(hashToHex(parsed.childHashes[0])).toBe(child.hex);
  });
});

// ─── Test Vector 4: node with duplicate ordered child refs ───

describe("test vector 4: node with duplicate ordered child refs", () => {
  it("[A, A] produces different hash from [A]", async () => {
    const child = await buildNode("text/plain", textEncoder.encode("dup"));
    const single = await buildNode("text/plain", textEncoder.encode("parent"), [child.digest]);
    const double = await buildNode("text/plain", textEncoder.encode("parent"), [
      child.digest,
      child.digest,
    ]);

    expect(single.hex).not.toBe(double.hex);
  });

  it("parses duplicate refs correctly", async () => {
    const child = await buildNode("text/plain", textEncoder.encode("dup"));
    const parent = await buildNode("text/plain", textEncoder.encode("parent"), [
      child.digest,
      child.digest,
    ]);

    const parsed = parseNodeBytes(parent.nodeBytes);
    expect(parsed.childHashes).toHaveLength(2);
    expect(hashToHex(parsed.childHashes[0])).toBe(child.hex);
    expect(hashToHex(parsed.childHashes[1])).toBe(child.hex);
  });
});

// ─── Test Vector 5: same content, different content types → different hashes ───

describe("test vector 5: same content with different content types", () => {
  it("produces different hashes", async () => {
    const content = textEncoder.encode("identical bytes");
    const a = await buildNode("text/plain", content);
    const b = await buildNode("application/json", content);
    expect(a.hex).not.toBe(b.hex);
  });
});

// ─── Test Vector 6: same content/metadata, reversed refs → different hashes ───

describe("test vector 6: reversed refs produce different hashes", () => {
  it("[A, B] != [B, A]", async () => {
    const childA = await buildNode("text/plain", textEncoder.encode("A"));
    const childB = await buildNode("text/plain", textEncoder.encode("B"));
    const content = textEncoder.encode("parent");

    const ab = await buildNode("text/plain", content, [childA.digest, childB.digest]);
    const ba = await buildNode("text/plain", content, [childB.digest, childA.digest]);

    expect(ab.hex).not.toBe(ba.hex);
  });
});

// ─── Test Vector 7: zero-byte R2 content ───

describe("test vector 7: zero-byte R2 content", () => {
  it("produces a valid node with contentSize=0", async () => {
    const node = await buildNode("text/plain", new Uint8Array(0));
    const decoded = decodeHeader(node.header);
    expect(decoded.contentSize).toBe(0);
    expect(node.hex).toHaveLength(64);
  });

  it("different from node with 1-byte content", async () => {
    const empty = await buildNode("text/plain", new Uint8Array(0));
    const one = await buildNode("text/plain", new Uint8Array([0x00]));
    expect(empty.hex).not.toBe(one.hex);
  });
});

// ─── Test Vector 8: maximum content type length ───

describe("test vector 8: maximum content type length", () => {
  it("accepts content type at max length", async () => {
    const longType = "a".repeat(MAX_CONTENT_TYPE_LENGTH);
    const node = await buildNode(longType, textEncoder.encode("x"));
    expect(node.hex).toHaveLength(64);

    const decoded = decodeHeader(node.header);
    expect(decoded.contentTypeLength).toBe(MAX_CONTENT_TYPE_LENGTH);
  });

  it("rejects content type exceeding max length", () => {
    const tooLong = "a".repeat(MAX_CONTENT_TYPE_LENGTH + 1);
    expect(() => validateContentType(tooLong)).toThrow("too long");
  });
});

// ─── Header encoding/decoding ───

describe("header encoding and decoding", () => {
  it("round-trips header fields", () => {
    const header = encodeHeader(12345, "image/png", 3);
    const decoded = decodeHeader(header);
    expect(decoded.signature[0]).toBe(0x55);
    expect(decoded.signature[1]).toBe(0x44);
    expect(decoded.version).toBe(1);
    expect(decoded.flags).toBe(0);
    expect(decoded.contentSize).toBe(12345);
    expect(decoded.refCount).toBe(3);
    expect(decoded.contentTypeLength).toBe("image/png".length);
    expect(decoded.reserved).toBe(0);
  });

  it("header is exactly 24 bytes", () => {
    const header = encodeHeader(0, "x", 0);
    expect(header.length).toBe(HEADER_SIZE);
  });
});

// ─── Digest and hex conversion ───

describe("digest utilities", () => {
  it("sha256 produces 32-byte hash", async () => {
    const hash = await sha256(textEncoder.encode("test"));
    expect(hash.length).toBe(HASH_SIZE);
  });

  it("hashToHex produces 64-char lowercase hex", async () => {
    const hash = await sha256(textEncoder.encode("test"));
    const hex = hashToHex(hash);
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hexToHash round-trips with hashToHex", async () => {
    const hash = await sha256(textEncoder.encode("roundtrip"));
    const hex = hashToHex(hash);
    const back = hexToHash(hex);
    expect(back).toEqual(hash);
  });

  it("rejects invalid hex length", () => {
    expect(() => hexToHash("abc")).toThrow("Expected 64 hex characters");
  });

  it("rejects invalid hash byte length", () => {
    expect(() => hashToHex(new Uint8Array(16))).toThrow("Expected 32 bytes");
  });
});

// ─── Validation ───

describe("validation", () => {
  describe("validateCanonicalNodeSize", () => {
    it("accepts a canonical node exactly at the byte limit", () => {
      const contentSize = MAX_CANONICAL_NODE_BYTES - HEADER_SIZE - 1;
      expect(validateCanonicalNodeSize(contentSize, 1, 0)).toBe(MAX_CANONICAL_NODE_BYTES);
    });

    it("rejects a canonical node one byte over the limit", () => {
      const contentSize = MAX_CANONICAL_NODE_BYTES - HEADER_SIZE;
      expect(() => validateCanonicalNodeSize(contentSize, 1, 0)).toThrow("Canonical node too large");
    });

    it("rejects child reference counts above the protocol limit", () => {
      expect(() => validateCanonicalNodeSize(0, 1, MAX_NODE_REFS + 1)).toThrow(
        "Child ref count out of range",
      );
    });
  });

  describe("validateHash", () => {
    it("accepts valid hash", () => {
      expect(() => validateHash("a".repeat(64))).not.toThrow();
    });

    it("rejects wrong length", () => {
      expect(() => validateHash("abc")).toThrow("64 characters");
    });

    it("rejects uppercase hex", () => {
      expect(() => validateHash("A".repeat(64))).toThrow("lowercase hex");
    });

    it("rejects non-hex characters", () => {
      expect(() => validateHash("g".repeat(64))).toThrow("lowercase hex");
    });
  });

  describe("validateContentType", () => {
    it("accepts valid content type", () => {
      expect(() => validateContentType("application/json")).not.toThrow();
    });

    it("rejects empty", () => {
      expect(() => validateContentType("")).toThrow("not be empty");
    });

    it("rejects NUL", () => {
      expect(() => validateContentType("text/\0plain")).toThrow("NUL");
    });

    it("rejects non-ASCII", () => {
      expect(() => validateContentType("tëxt/plain")).toThrow("printable ASCII");
    });
  });

  describe("validateDecodedHeader", () => {
    it("accepts valid header", () => {
      const header = encodeHeader(100, "text/plain", 2);
      const decoded = decodeHeader(header);
      expect(() => validateDecodedHeader(decoded)).not.toThrow();
    });

    it("rejects bad signature", () => {
      const header = encodeHeader(100, "text/plain", 2);
      header[0] = 0x00; // corrupt signature
      const decoded = decodeHeader(header);
      expect(() => validateDecodedHeader(decoded)).toThrow("signature");
    });

    it("rejects bad version", () => {
      const header = encodeHeader(100, "text/plain", 2);
      const view = new DataView(header.buffer);
      view.setUint16(2, 99, true); // bad version
      const decoded = decodeHeader(header);
      expect(() => validateDecodedHeader(decoded)).toThrow("version");
    });
  });

  describe("validateChildRefs", () => {
    it("accepts matching count", () => {
      const refs = ["a".repeat(64), "b".repeat(64)];
      expect(() => validateChildRefs(refs, 2)).not.toThrow();
    });

    it("rejects count mismatch", () => {
      expect(() => validateChildRefs(["a".repeat(64)], 2)).toThrow("mismatch");
    });
  });

  describe("validateContentLength", () => {
    it("accepts matching length", () => {
      expect(() => validateContentLength(100, 100)).not.toThrow();
    });

    it("rejects mismatch", () => {
      expect(() => validateContentLength(99, 100)).toThrow("mismatch");
    });
  });
});

describe("canonical node streams", () => {
  it("parses a fragmented prefix and replays every canonical byte", async () => {
    const child = await buildNode("text/plain", textEncoder.encode("child"));
    const node = await buildNode("application/octet-stream", textEncoder.encode("payload"), [child.digest]);
    const parsed = await parseCanonicalNodeStream(fragmentedStream(node.nodeBytes, 3), node.nodeBytes.length);

    expect(parsed).toMatchObject({
      contentSize: 7,
      contentType: "application/octet-stream",
      refs: [child.hex],
      canonicalSize: node.nodeBytes.length,
    });
    expect(new Uint8Array(await new Response(parsed.body).arrayBuffer())).toEqual(node.nodeBytes);
  });

  it("rejects trailing bytes while the replay stream is consumed", async () => {
    const node = await buildNode("text/plain", textEncoder.encode("payload"));
    const withTrailing = new Uint8Array(node.nodeBytes.length + 1);
    withTrailing.set(node.nodeBytes);
    await expect(async () => {
      const parsed = await parseCanonicalNodeStream(fragmentedStream(withTrailing, 5));
      await new Response(parsed.body).arrayBuffer();
    }).rejects.toThrow("exceeds declared");
  });

  it("rejects a Content-Length that disagrees with the canonical header", async () => {
    const node = await buildNode("text/plain", textEncoder.encode("payload"));
    await expect(parseCanonicalNodeStream(
      fragmentedStream(node.nodeBytes, 7),
      node.nodeBytes.length + 1,
    )).rejects.toThrow("Content-Length says");
  });
});

// ─── Parse errors ───

describe("parseNodeBytes errors", () => {
  it("rejects too-short input", () => {
    expect(() => parseNodeBytes(new Uint8Array(10))).toThrow("too short");
  });

  it("rejects length mismatch", () => {
    const header = encodeHeader(10, "text/plain", 0);
    const contentTypeBytes = textEncoder.encode("text/plain");
    // Build bytes that are too short (missing content)
    const shortBytes = concatenateNodeBytes(
      header,
      contentTypeBytes,
      [],
      new Uint8Array(5), // only 5 bytes instead of 10
    );
    // The concatenated bytes are correct length for contentSize=5,
    // but header says contentSize=10, so parseNodeBytes will see a mismatch
    expect(() => parseNodeBytes(shortBytes)).toThrow("mismatch");
  });
});
