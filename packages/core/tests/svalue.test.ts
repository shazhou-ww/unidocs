import { describe, expect, it } from "vitest";
import {
  collectSBlobRefs,
  decodeSValue,
  encodeSValue,
  isSBlob,
  refsFromSValue,
  SBlobTag,
  SValueContentType,
} from "../src/index.js";
import {
  createSBlob,
  decodeSValueWithRefs,
  encodeSValueWithRefs,
} from "../src/svalue.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}

describe("SValue version 1", () => {
  it("uses the frozen media type and SBlob tag", () => {
    expect(SValueContentType).toBe("application/vnd.unidocs.svalue+cbor;version=1");
    expect(SBlobTag).toBe(65_536);
  });

  it("encodes equal objects identically regardless of insertion order", () => {
    const first = { aa: 1, b: 2 };
    const second: Record<string, number> = {};
    second.b = 2;
    second.aa = 1;

    const encoded = encodeSValue(first);
    expect(hex(encoded)).toBe("a261620262616101");
    expect(encoded.byteOffset).toBe(0);
    expect(encoded.buffer.byteLength).toBe(encoded.byteLength);
    expect(encoded.constructor).toBe(Uint8Array);
    expect(encodeSValue(second)).toEqual(encoded);
  });

  it("encodes SBlobs as tag 65536 with raw hashes", () => {
    const hash = Array.from({ length: 32 }, (_, index) =>
      index.toString(16).padStart(2, "0")).join("");
    const blob = createSBlob(hash);

    expect(isSBlob(blob)).toBe(true);
    expect(hex(encodeSValue(blob))).toBe(
      "da000100005820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    );
  });

  it("derives ordered duplicate refs from canonical traversal", () => {
    const first = createSBlob("11".repeat(32));
    const second = createSBlob("22".repeat(32));
    const value = { long: first, x: [second, first] };

    const encoded = encodeSValueWithRefs(value);
    const decoded = decodeSValueWithRefs(encoded.data);

    expect(encoded.refs).toEqual([second.hash, first.hash, first.hash]);
    expect(decoded.refs).toEqual(encoded.refs);
    expect(isSBlob((decoded.value as { x: readonly unknown[] }).x[0])).toBe(true);
    expect(Object.isFrozen(decoded.value)).toBe(true);
    expect(refsFromSValue(value)).toEqual({ [second.hash]: 1, [first.hash]: 2 });
  });

  it("collectSBlobRefs walks mixed trees and skips binary leaves", () => {
    const blob = createSBlob("33".repeat(32));
    const tree = {
      files: { "/a": blob, "/b": blob },
      pixels: { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]) },
    };
    expect(collectSBlobRefs(tree)).toEqual({ [blob.hash]: 2 });
    expect(collectSBlobRefs("plain")).toEqual({});
  });

  it("round trips null-prototype objects and prototype-sensitive keys", () => {
    const value = Object.create(null) as Record<string, string>;
    Object.defineProperty(value, "__proto__", { enumerable: true, value: "data" });

    const decoded = decodeSValue(encodeSValue(value)) as Record<string, string>;

    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(decoded.__proto__).toBe("data");
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["bigint", 1n],
    ["isolated surrogate", String.fromCharCode(0xd800)],
    ["class instance", new Date(0)],
  ])("rejects %s", (_name, value) => {
    expect(() => encodeSValue(value as never)).toThrow(/Invalid SValue/);
  });

  it("rejects sparse arrays, accessors, symbols, and cycles", () => {
    const sparse = new Array(2);
    sparse[1] = "x";
    expect(() => encodeSValue(sparse as never)).toThrow(/dense/);

    const accessor = Object.defineProperty({}, "x", { enumerable: true, get: () => 1 });
    expect(() => encodeSValue(accessor as never)).toThrow(/data properties/);

    const symbol = { x: 1 } as Record<PropertyKey, unknown>;
    symbol[Symbol("x")] = 2;
    expect(() => encodeSValue(symbol as never)).toThrow(/symbol properties/);

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => encodeSValue(cycle as never)).toThrow(/circular/);
  });

  it("rejects non-canonical and non-SValue CBOR", () => {
    expect(() => decodeSValue(fromHex("1801"))).toThrow();
    expect(() => decodeSValue(fromHex("fb3ff0000000000000"))).toThrow(/canonical/);
    expect(() => decodeSValue(fromHex("f7"))).toThrow();
    expect(() => decodeSValue(fromHex("4100"))).toThrow(/objects must/);
    expect(() => decodeSValue(fromHex("c001"))).toThrow();
    expect(() => decodeSValue(fromHex("0102"))).toThrow();
  });

  it("rejects malformed SBlob tags and configured limit violations", () => {
    expect(() => decodeSValue(fromHex("da000100004100"))).toThrow(/32 bytes/);
    expect(() => encodeSValue([1, 2], { limits: { maxArrayLength: 1 } })).toThrow(/array exceeds/);
    expect(() => decodeSValue(encodeSValue("abc"), {
      limits: { maxEncodedBytes: 1 },
    })).toThrow(/encoding exceeds/);
  });

  it("rejects declared sizes and depth before decoding their contents", () => {
    expect(() => decodeSValue(fromHex("5864"), {
      limits: { maxByteStringBytes: 32 },
    })).toThrow(/byte string exceeds/);
    expect(() => decodeSValue(fromHex("7864"), {
      limits: { maxStringBytes: 10 },
    })).toThrow(/string exceeds/);
    expect(() => decodeSValue(fromHex("9864"), {
      limits: { maxArrayLength: 10 },
    })).toThrow(/array exceeds/);
    expect(() => decodeSValue(fromHex("b864"), {
      limits: { maxMapEntries: 10 },
    })).toThrow(/map exceeds/);
    expect(() => decodeSValue(fromHex("818181f6"), {
      limits: { maxDepth: 2 },
    })).toThrow(/nesting exceeds/);
  });
});