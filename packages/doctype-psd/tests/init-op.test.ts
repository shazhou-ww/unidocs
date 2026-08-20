import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import type { BlobStore } from "../src/render/pixel-source.js";
import { apply } from "../src/ops/index.js";
import { serialize, deserialize } from "../src/psd/ir.js";

function memStore(): BlobStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  return {
    blobs,
    async put(bytes: Uint8Array) {
      const hash = `blob${n++}`;
      blobs.set(hash, bytes);
      return hash;
    },
    async get(hash: string) {
      return blobs.get(hash) ?? null;
    },
  };
}

const leaf = (id: string): Layer => ({
  id,
  type: "raster",
  name: id,
  bounds: [0, 0, 1, 1],
  opacity: 1,
  blendMode: "normal",
  visible: true,
  locked: false,
  clipping: false,
  pixels: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
});

const startDoc = (): PsdDoc => ({
  canvas: { width: 10, height: 10, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [leaf("X")],
});

const irDoc = (): PsdDoc => ({
  canvas: { width: 20, height: 30, colorMode: "RGB", depth: 8, resolution: 300, profile: "AdobeRGB" },
  layers: [leaf("A"), leaf("B")],
});

describe("init op", () => {
  it("replaces the whole document (canvas + layers) rather than merging", async () => {
    const start = startDoc();
    const ir = irDoc();

    const result = await apply([{ kind: "init", payload: ir }], start);

    expect(result.canvas).toEqual(ir.canvas);
    expect(result.layers.map((l) => l.id)).toEqual(["A", "B"]);
    expect(result.layers.find((l) => l.id === "X")).toBeUndefined();
  });

  it("does not mutate the input doc in place", async () => {
    const start = startDoc();
    const ir = irDoc();

    await apply([{ kind: "init", payload: ir }], start);

    expect(start.canvas).toEqual({ width: 10, height: 10, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" });
    expect(start.layers.map((l) => l.id)).toEqual(["X"]);
  });

  it("defaults layers to [] when payload has no layers", async () => {
    const start = startDoc();
    const result = await apply(
      [{ kind: "init", payload: { canvas: irDoc().canvas } }],
      start
    );
    expect(result.layers).toEqual([]);
  });

  it("throws and does not mutate doc when canvas is missing", async () => {
    const start = startDoc();
    const startSnapshot = structuredClone(start);

    await expect(
      apply([{ kind: "init", payload: { canvas: undefined, layers: [] } }], start)
    ).rejects.toThrow(/init: malformed payload/);

    expect(start).toEqual(startSnapshot);
  });

  it("throws when canvas has non-numeric width/height", async () => {
    const start = startDoc();

    await expect(
      apply([{ kind: "init", payload: { canvas: { width: "x", height: 1 } } }], start)
    ).rejects.toThrow(/init: malformed payload/);
  });

  it("throws when layers is present but not an array", async () => {
    const start = startDoc();

    await expect(
      apply([{ kind: "init", payload: { canvas: irDoc().canvas, layers: "x" } }], start)
    ).rejects.toThrow(/init: malformed payload/);
  });

  it("round-trip smoke: deserialize(serialize(doc)) fed as init payload restores it structurally", async () => {
    const store = memStore();
    const start = startDoc();
    const ir = irDoc();

    const bytes = await serialize(ir, store);
    const restored = await deserialize(bytes, store);

    const result = await apply([{ kind: "init", payload: restored }], start);

    expect(result.canvas).toEqual(ir.canvas);
    expect(result.layers.map((l) => l.id)).toEqual(["A", "B"]);
  });
});
