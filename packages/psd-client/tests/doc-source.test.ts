import { describe, it, expect } from "vitest";
import { loadDoc } from "../src/doc-source.js";
import type { BlobStore } from "@unidocs/doctype-psd/engine";

const irJson = JSON.stringify({ canvas: { width: 2, height: 2, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [] });
const irBytes = new TextEncoder().encode(irJson);
const memStore = (m: Record<string, Uint8Array> = {}): BlobStore => ({ async get(h) { return m[h] ?? null; }, async put() { return ""; } });

const irFetch = (opts: { version?: number; ok?: boolean; status?: number; bytes?: Uint8Array } = {}): typeof fetch =>
  (async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name: string) => (name === "X-Doc-Version" ? String(opts.version ?? 3) : null) },
    arrayBuffer: async () => (opts.bytes ?? irBytes).buffer,
  } as unknown as Response)) as unknown as typeof fetch;

describe("loadDoc", () => {
  it("fetches IR bytes from the /ir endpoint → deserialized doc + version", async () => {
    const store = memStore();
    const { doc, version } = await loadDoc({ gw: "/gw", user: "u1", type: "psd", docId: "d1", store, fetchImpl: irFetch({ version: 3 }) });
    expect(version).toBe(3);
    expect(doc.canvas.width).toBe(2);
    expect(doc.layers).toEqual([]);
  });

  it("throws a clear error when the /ir fetch fails", async () => {
    const store = memStore();
    await expect(
      loadDoc({ gw: "/gw", user: "u1", type: "psd", docId: "d1", store, fetchImpl: irFetch({ ok: false, status: 404 }) })
    ).rejects.toThrow(/GET ir failed with status 404/);
  });
});
