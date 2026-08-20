import { describe, expect, it } from "vitest";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createR2BlobStore } from "../src/blob-store.js";

function createInMemoryR2(): R2Bucket {
  const map = new Map<string, Uint8Array>();
  return {
    put(key: string, value: Uint8Array) {
      map.set(key, value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer));
      return Promise.resolve(undefined);
    },
    get(key: string) {
      const bytes = map.get(key);
      if (!bytes) return Promise.resolve(null);
      return Promise.resolve({
        arrayBuffer: () => Promise.resolve(bytes.buffer),
      });
    },
    // exposed for assertions in tests below
    __map: map,
  } as unknown as R2Bucket;
}

describe("createR2BlobStore", () => {
  it("put returns a content hash", async () => {
    const store = createR2BlobStore(createInMemoryR2());
    const hash = await store.put(new Uint8Array([1, 2, 3]));
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is idempotent: identical bytes produce identical hash and don't grow the store", async () => {
    const cas = createInMemoryR2();
    const store = createR2BlobStore(cas);
    const bytes = new Uint8Array([9, 9, 9, 9]);

    const hash1 = await store.put(bytes);
    const hash2 = await store.put(bytes);

    expect(hash1).toBe(hash2);
    expect((cas as unknown as { __map: Map<string, Uint8Array> }).__map.size).toBe(1);
  });

  it("get round-trips the exact bytes that were put", async () => {
    const store = createR2BlobStore(createInMemoryR2());
    const original = new Uint8Array([10, 20, 30, 40, 250, 255, 0]);

    const hash = await store.put(original);
    const roundTripped = await store.get(hash);

    expect(roundTripped).toEqual(original);
  });

  it("get returns null for an unknown hash", async () => {
    const store = createR2BlobStore(createInMemoryR2());
    const result = await store.get("0000000000000000");
    expect(result).toBeNull();
  });

  it("different byte arrays produce different hashes", async () => {
    const store = createR2BlobStore(createInMemoryR2());
    const hashA = await store.put(new Uint8Array([1, 2, 3]));
    const hashB = await store.put(new Uint8Array([4, 5, 6]));
    expect(hashA).not.toBe(hashB);
  });
});
