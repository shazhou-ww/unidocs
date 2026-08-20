import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import type { BlobStore } from "../src/render/pixel-source.js";
import { isRef, resolvePixels, PixelCache } from "../src/render/pixel-source.js";
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
  const child: Layer = {
    id: "child-1",
    type: "raster",
    name: "Child Raster",
    bounds: [0, 0, 2, 2],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 2, height: 2, data: fill(2, 2, [10, 20, 30, 255]) },
    mask: {
      pixels: {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
      },
      bounds: [0, 0, 2, 2],
      defaultColor: 255,
      inverted: false,
    },
  };

  const group: Layer = {
    id: "group-1",
    type: "group",
    name: "Group",
    bounds: [0, 0, 2, 2],
    opacity: 1,
    blendMode: "pass-through",
    visible: true,
    locked: false,
    clipping: false,
    children: [child],
  };

  const topRaster: Layer = {
    id: "top-1",
    type: "raster",
    name: "Top Raster",
    bounds: [0, 0, 4, 4],
    opacity: 0.5,
    fillOpacity: 0.8,
    blendMode: "multiply",
    visible: true,
    locked: true,
    clipping: false,
    pixels: { width: 4, height: 4, data: fill(4, 4, [200, 100, 50, 200]) },
  };

  const adj: Layer = {
    id: "adj-1",
    type: "adjustment",
    name: "Brightness",
    bounds: [0, 0, 4, 4],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    adjustType: "brit",
    params: { brightness: 10, contrast: 0 },
  };

  return { canvas, layers: [group, topRaster, adj] };
}

function findLayer(layers: Layer[], id: string): Layer | undefined {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) {
      const found = findLayer(l.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

describe("psd IR serialize/deserialize", () => {
  it("serialize produces byte-free JSON with per-layer PNG blobs in the store", async () => {
    const store = memStore();
    const doc = buildDoc();
    const bytes = await serialize(doc, store);

    expect(bytes).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(bytes);
    const ir = JSON.parse(text);

    // No large numeric pixel arrays anywhere in the raw text.
    expect(text).not.toMatch(/"data"\s*:/);

    const irChild = ir.layers[0].children[0];
    expect(irChild.pixels).toBeDefined();
    expect(typeof irChild.pixels.hash).toBe("string");
    expect(irChild.pixels.width).toBe(2);
    expect(irChild.pixels.height).toBe(2);
    expect(irChild.pixels.data).toBeUndefined();

    // mask also byte-free, hash-referenced
    expect(irChild.mask.pixels.hash).toBeTypeOf("string");
    expect(irChild.mask.pixels.data).toBeUndefined();
    expect(irChild.mask.bounds).toEqual([0, 0, 2, 2]);
    expect(irChild.mask.defaultColor).toBe(255);

    const irTop = ir.layers[1];
    expect(irTop.pixels.hash).toBeTypeOf("string");
    expect(irTop.fillOpacity).toBe(0.8);
    expect(irTop.locked).toBe(true);

    const irAdj = ir.layers[2];
    expect(irAdj.pixels).toBeUndefined();
    expect(irAdj.adjustType).toBe("brit");
    expect(irAdj.params).toEqual({ brightness: 10, contrast: 0 });

    // store now holds a blob per raster layer's pixels + the mask blob
    expect(store.blobs.size).toBe(3); // child pixels, top pixels, mask
  });

  it("deserialize yields lazy PixelRef layers with structure preserved, and pixels resolve byte-identical", async () => {
    const store = memStore();
    const original = buildDoc();
    const bytes = await serialize(original, store);
    const doc = await deserialize(bytes, store);

    expect(doc.canvas).toEqual(canvas);
    expect(doc.layers).toHaveLength(3);

    const group = doc.layers[0];
    expect(group.id).toBe("group-1");
    expect(group.type).toBe("group");
    expect(group.children).toHaveLength(1);

    const child = findLayer(doc.layers, "child-1")!;
    expect(child.bounds).toEqual([0, 0, 2, 2]);
    expect(child.blendMode).toBe("normal");
    expect(isRef(child.pixels!)).toBe(true);

    const cache = new PixelCache(8);
    const resolvedChild = await resolvePixels(child.pixels!, store, cache);
    expect([...resolvedChild.data]).toEqual([...fill(2, 2, [10, 20, 30, 255])]);

    // mask round-trips to RESIDENT pixels, byte-identical
    expect(child.mask).toBeDefined();
    expect(child.mask!.pixels.width).toBe(2);
    expect(child.mask!.pixels.height).toBe(2);
    expect(child.mask!.pixels.data).toBeInstanceOf(Uint8ClampedArray);
    expect([...child.mask!.pixels.data]).toEqual([
      0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    ]);
    expect(child.mask!.bounds).toEqual([0, 0, 2, 2]);
    expect(child.mask!.defaultColor).toBe(255);
    expect(child.mask!.inverted).toBe(false);

    const top = doc.layers[1];
    expect(top.id).toBe("top-1");
    expect(top.opacity).toBe(0.5);
    expect(top.fillOpacity).toBe(0.8);
    expect(top.locked).toBe(true);
    expect(isRef(top.pixels!)).toBe(true);
    const resolvedTop = await resolvePixels(top.pixels!, store, cache);
    expect([...resolvedTop.data]).toEqual([...fill(4, 4, [200, 100, 50, 200])]);

    const adj = doc.layers[2];
    expect(adj.type).toBe("adjustment");
    expect(adj.pixels).toBeUndefined();
    expect(adj.adjustType).toBe("brit");
    expect(adj.params).toEqual({ brightness: 10, contrast: 0 });
  });

  it("empty mask (width 0) round-trips without a hash and with empty resident data", async () => {
    const store = memStore();
    const layer: Layer = {
      id: "l1",
      type: "raster",
      name: "L",
      bounds: [0, 0, 1, 1],
      opacity: 1,
      blendMode: "normal",
      visible: true,
      locked: false,
      clipping: false,
      pixels: { width: 1, height: 1, data: fill(1, 1, [1, 2, 3, 255]) },
      mask: {
        pixels: { width: 0, height: 0, data: new Uint8ClampedArray(0) },
        bounds: [0, 0, 0, 0],
        defaultColor: 0,
        inverted: false,
      },
    };
    const doc: PsdDoc = { canvas, layers: [layer] };
    const bytes = await serialize(doc, store);
    const ir = JSON.parse(new TextDecoder().decode(bytes));
    expect(ir.layers[0].mask.pixels.hash).toBeUndefined();
    expect(ir.layers[0].mask.pixels.width).toBe(0);

    const back = await deserialize(bytes, store);
    const m = back.layers[0].mask!;
    expect(m.pixels.width).toBe(0);
    expect(m.pixels.height).toBe(0);
    expect(m.pixels.data).toBeInstanceOf(Uint8ClampedArray);
    expect(m.pixels.data.length).toBe(0);
  });

  it("PixelRef pixels are kept as-is on serialize (not re-stored) and preserved on deserialize", async () => {
    const store = memStore();
    const preRef = { width: 2, height: 2, hash: "pre-existing-hash" };
    store.blobs.set("pre-existing-hash", (await import("fast-png")).encode({
      width: 2,
      height: 2,
      data: fill(2, 2, [7, 8, 9, 255]),
      channels: 4,
      depth: 8,
    }));
    const layer: Layer = {
      id: "ref-layer",
      type: "raster",
      name: "Ref",
      bounds: [0, 0, 2, 2],
      opacity: 1,
      blendMode: "normal",
      visible: true,
      locked: false,
      clipping: false,
      pixels: preRef,
    };
    const doc: PsdDoc = { canvas, layers: [layer] };
    const sizeBefore = store.blobs.size;
    const bytes = await serialize(doc, store);
    expect(store.blobs.size).toBe(sizeBefore); // not re-stored

    const ir = JSON.parse(new TextDecoder().decode(bytes));
    expect(ir.layers[0].pixels.hash).toBe("pre-existing-hash");

    const back = await deserialize(bytes, store);
    expect(isRef(back.layers[0].pixels!)).toBe(true);
    expect((back.layers[0].pixels as any).hash).toBe("pre-existing-hash");
  });
});
