import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import type { BlobStore } from "../src/render/pixel-source.js";
import { isRef, resolvePixels, PixelCache } from "../src/render/pixel-source.js";
import { serialize, deserialize } from "../src/psd/ir.js";
import { resolveDoc, resolveLayerPixels } from "../src/resolve.js";
import { apply } from "../src/ops/index.js";
import { save } from "../src/psd/save.js";
import { findLayer } from "../src/model/tree.js";

/** In-memory content-addressed BlobStore. */
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

const canvas = { width: 2, height: 1, colorMode: "RGB" as const, depth: 8 as const, resolution: 72, profile: "sRGB" };

/** 2x1 raster: left pixel red, right pixel green — so a horizontal flip is
 *  observable (the two swap). */
function rasterData(): Uint8ClampedArray {
  return new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
}

function buildDoc(): PsdDoc {
  const child: Layer = {
    id: "child-1",
    type: "raster",
    name: "Child",
    bounds: [0, 0, 1, 2],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 2, height: 1, data: rasterData() },
  };
  const group: Layer = {
    id: "group-1",
    type: "group",
    name: "Group",
    bounds: [0, 0, 1, 2],
    opacity: 1,
    blendMode: "pass-through",
    visible: true,
    locked: false,
    clipping: false,
    children: [child],
  };
  const top: Layer = {
    id: "top-1",
    type: "raster",
    name: "Top",
    bounds: [0, 0, 1, 2],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 2, height: 1, data: rasterData() },
  };
  return { canvas, layers: [group, top] };
}

/** serialize → deserialize = a "cold reload": every raster is a lazy PixelRef. */
async function lazyReload(store: BlobStore, doc: PsdDoc): Promise<PsdDoc> {
  const bytes = await serialize(doc, store);
  return deserialize(bytes, store);
}

describe("resolveDoc / resolveLayerPixels (C1/C2 fault-in)", () => {
  it("C1: a lazy (cold-reloaded) doc cannot be saved until resolveDoc faults in its refs", async () => {
    const store = memStore();
    const lazy = await lazyReload(store, buildDoc());

    // Precondition: reload yielded lazy refs.
    expect(isRef(findLayer(lazy.layers, "child-1")!.pixels!)).toBe(true);
    expect(isRef(findLayer(lazy.layers, "top-1")!.pixels!)).toBe(true);

    // Regression the fix prevents: save() throws on an unresolved PixelRef.
    await expect(save(lazy)).rejects.toThrow(/PixelRef/);

    // resolveDoc faults EVERY layer (nested included) to resident, non-mutating
    // the input doc, and the result saves to valid PSD bytes.
    const resolved = await resolveDoc(lazy, store);
    expect(isRef(findLayer(resolved.layers, "child-1")!.pixels!)).toBe(false);
    expect(isRef(findLayer(resolved.layers, "top-1")!.pixels!)).toBe(false);
    // input untouched (resolveDoc returns a new doc)
    expect(isRef(findLayer(lazy.layers, "child-1")!.pixels!)).toBe(true);

    // pixel bytes are byte-identical to the original
    expect([...(findLayer(resolved.layers, "child-1")!.pixels as any).data]).toEqual([...rasterData()]);

    const bytes = await save(resolved);
    expect(bytes).toBeInstanceOf(Uint8Array);
    // PSD magic '8BPS'
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x38, 0x42, 0x50, 0x53]);
  });

  it("resolveLayerPixels faults only the target layer, leaving siblings lazy", async () => {
    const store = memStore();
    const lazy = await lazyReload(store, buildDoc());

    const resolved = await resolveLayerPixels(lazy, "top-1", store);
    expect(isRef(findLayer(resolved.layers, "top-1")!.pixels!)).toBe(false);
    // sibling stays lazy — memory win preserved
    expect(isRef(findLayer(resolved.layers, "child-1")!.pixels!)).toBe(true);
    // input untouched
    expect(isRef(findLayer(lazy.layers, "top-1")!.pixels!)).toBe(true);
  });

  it("C2: apply([flip], lazyDoc, {store}) resolves + flips; without store it throws loudly", async () => {
    const store = memStore();

    const flipOp = { kind: "transform", payload: { layerId: "top-1", op: { flip: "h" } } };

    // With store: pre-resolves the target, flip succeeds.
    const lazy1 = await lazyReload(store, buildDoc());
    const flipped = await apply([flipOp], lazy1, { store });
    const px = findLayer(flipped.layers, "top-1")!.pixels as any;
    expect(isRef(px)).toBe(false);
    // horizontal flip of [red, green] → [green, red]
    expect([...px.data]).toEqual([0, 255, 0, 255, 255, 0, 0, 255]);
    // untouched layer stays lazy
    expect(isRef(findLayer(flipped.layers, "child-1")!.pixels!)).toBe(true);

    // Without store: the loud no-store guard still fires on the lazy ref.
    const lazy2 = await lazyReload(store, buildDoc());
    await expect(apply([flipOp], lazy2)).rejects.toThrow(/PixelRef/);
  });

  it("resident-doc apply(flip) is unchanged whether or not a store is passed", async () => {
    const store = memStore();
    const flipOp = { kind: "transform", payload: { layerId: "top-1", op: { flip: "h" } } };

    const a = await apply([flipOp], buildDoc());
    const b = await apply([flipOp], buildDoc(), { store });
    expect([...(findLayer(a.layers, "top-1")!.pixels as any).data]).toEqual(
      [...(findLayer(b.layers, "top-1")!.pixels as any).data],
    );
  });
});
