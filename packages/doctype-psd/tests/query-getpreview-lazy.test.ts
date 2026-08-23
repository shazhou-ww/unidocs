import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { PsdDoc, Layer } from "../src/model/types.js";
import type { BlobStore } from "../src/render/pixel-source.js";
import { serialize, deserialize } from "../src/psd/ir.js";
import { runQuery } from "../src/queries.js";

function memStore(): BlobStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  return {
    blobs,
    async put(bytes: Uint8Array) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    },
    async get(hash: string) {
      return blobs.get(hash) ?? null;
    },
  };
}

function fill(w: number, h: number, [r, g, b, a]: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = r;
    d[i * 4 + 1] = g;
    d[i * 4 + 2] = b;
    d[i * 4 + 3] = a;
  }
  return d;
}

const canvas = { width: 4, height: 4, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

function buildDoc(): PsdDoc {
  const bottom: Layer = {
    id: "bottom",
    type: "raster",
    name: "Bottom",
    bounds: [0, 0, 4, 4],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 4, height: 4, data: fill(4, 4, [255, 0, 0, 255]) },
  };
  const top: Layer = {
    id: "top",
    type: "raster",
    name: "Top",
    bounds: [0, 0, 2, 2],
    opacity: 0.5,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 2, height: 2, data: fill(2, 2, [0, 0, 255, 255]) },
  };
  return { canvas, layers: [bottom, top] };
}

describe("runQuery getPreview on a lazy (PixelRef) doc", () => {
  it("throws NO_STORE when no ctx is supplied", async () => {
    const store = memStore();
    const resident = buildDoc();
    const bytes = await serialize(resident, store);
    const lazyDoc = await deserialize(bytes, store);

    await expect(runQuery({ kind: "getPreview" }, lazyDoc)).rejects.toThrow(/BlobStore/);
  });

  // The lazy render-from-store path through runQuery (ctx.cas → RenderCtx) is
  // covered end-to-end in tests/cas-render.test.ts, which builds a real
  // CAS-backed ctx and asserts byte-identical output vs the resident render.

  it("existing no-ctx resident-doc path is unaffected (back-compat)", async () => {
    const resident = buildDoc();
    const out = (await runQuery({ kind: "getPreview" }, resident)) as any;
    expect(out.$image.mediaType).toBe("image/png");
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
  });
});
