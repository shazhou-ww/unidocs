import { describe, it, expect } from "vitest";
import { loadDoc } from "../src/doc-source.js";
import type { BlobStore } from "@unidocs/doctype-psd/engine";

const irJson = JSON.stringify({ canvas: { width: 2, height: 2, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [] });
const memStore = (m: Record<string, Uint8Array>): BlobStore => ({ async get(h) { return m[h] ?? null; }, async put() { return ""; } });
const snapFetch = (): typeof fetch => (async () => ({ ok: true, json: async () => ({ success: true, version: 3, hash: "ir1" }) } as unknown as Response)) as unknown as typeof fetch;

describe("loadDoc", () => {
  it("fetches snapshot hash → IR bytes → deserialized doc + version", async () => {
    const store = memStore({ ir1: new TextEncoder().encode(irJson) });
    const { doc, version } = await loadDoc({ gw: "/gw", user: "u1", type: "psd", docId: "d1", store, fetchImpl: snapFetch() });
    expect(version).toBe(3);
    expect(doc.canvas.width).toBe(2);
    expect(doc.layers).toEqual([]);
  });

  it("throws a clear error when the IR blob is missing from the store", async () => {
    const store = memStore({});
    await expect(
      loadDoc({ gw: "/gw", user: "u1", type: "psd", docId: "d1", store, fetchImpl: snapFetch() })
    ).rejects.toThrow(/IR blob missing for hash/);
  });
});
