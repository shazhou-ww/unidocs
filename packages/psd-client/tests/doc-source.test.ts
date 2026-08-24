import { describe, it, expect } from "vitest";
import { encodeSValue } from "@unidocs/svalue-codec";
import { loadDoc } from "../src/doc-source.js";
import type { BlobStore } from "@unidocs/doctype-psd/engine";

const snapshotBytes = encodeSValue({
  canvas: { width: 2, height: 2, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [],
});
const memStore = (m: Record<string, Uint8Array> = {}): BlobStore => ({ async get(h) { return m[h] ?? null; }, async put() { return ""; } });

const stateFetch = (opts: { version?: number; ok?: boolean; status?: number; bytes?: Uint8Array } = {}): typeof fetch =>
  (async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name: string) => (name === "X-Doc-Version" ? String(opts.version ?? 3) : null) },
    arrayBuffer: async () => (opts.bytes ?? snapshotBytes).buffer,
  } as unknown as Response)) as unknown as typeof fetch;

describe("loadDoc", () => {
  it("fetches canonical PsdStoredDoc bytes and materializes a lazy doc", async () => {
    const store = memStore();
    const { doc, version, snapshot } = await loadDoc({ gw: "/gw", user: "u1", type: "psd", docId: "d1", store, fetchImpl: stateFetch({ version: 3 }) });
    expect(version).toBe(3);
    expect(doc.canvas.width).toBe(2);
    expect(doc.layers).toEqual([]);
    expect(snapshot).toEqual(snapshotBytes);
  });

  it("throws a clear error when the /ir fetch fails", async () => {
    const store = memStore();
    await expect(
      loadDoc({ gw: "/gw", user: "u1", type: "psd", docId: "d1", store, fetchImpl: stateFetch({ ok: false, status: 404 }) })
    ).rejects.toThrow(/GET current state failed with status 404/);
  });
});
