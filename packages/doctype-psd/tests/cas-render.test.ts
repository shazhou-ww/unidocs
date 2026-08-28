import { describe, it, expect } from "vitest";
import { isSBlob } from "@unidocs/svalue-codec";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { serialize, deserialize } from "../src/psd/ir.js";
import { casBlobStore } from "../src/psd/cas-blobstore.js";
import { isRef } from "../src/render/pixel-source.js";
import { runQuery } from "../src/queries.js";
import { apply } from "../src/ops/index.js";
import { createMemorySBlobContext } from "./sblob-test-context.js";

/**
 * Wires the render (getPreview) and the flip op to fault lazy PixelRef
 * pixels in from the CAS via `ctx.makeSBlob` / `ctx.openSBlob`.
 */
const memCas = createMemorySBlobContext;

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

function residentDoc(): PsdDoc {
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
  // Distinct-per-quadrant so a horizontal flip is verifiable: left half red,
  // right half green (row 0), so post-flip columns swap.
  const flipData = new Uint8ClampedArray(2 * 2 * 4);
  const px = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const i = (y * 2 + x) * 4;
    flipData[i] = r; flipData[i + 1] = g; flipData[i + 2] = b; flipData[i + 3] = a;
  };
  px(0, 0, 255, 0, 0, 255); // top-left red
  px(1, 0, 0, 255, 0, 255); // top-right green
  px(0, 1, 0, 0, 255, 255); // bottom-left blue
  px(1, 1, 255, 255, 0, 255); // bottom-right yellow
  const top: Layer = {
    id: "top",
    type: "raster",
    name: "Top",
    bounds: [0, 0, 2, 2],
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
    clipping: false,
    pixels: { width: 2, height: 2, data: flipData },
  };
  return { canvas, layers: [bottom, top] };
}

describe("CAS-backed lazy render + flip fault-in", () => {
  it("getPreview on a lazy doc (with ctx.cas) renders byte-identically to the resident doc", async () => {
    const { ctx } = memCas();
    const resident = residentDoc();
    const store = casBlobStore(ctx);
    const bytes = await serialize(resident, store);
    const lazyDoc = await deserialize(bytes, store);

    // Confirm the doc really is lazy before proving fault-in works.
    for (const l of lazyDoc.layers) expect(isRef(l.pixels!)).toBe(true);

    const lazyResult = (await runQuery({ kind: "getPreview" }, lazyDoc, ctx)) as any;
    const residentResult = (await runQuery({ kind: "getPreview" }, residentDoc(), ctx)) as any;

    expect(lazyResult.width).toBe(residentResult.width);
    expect(lazyResult.height).toBe(residentResult.height);
    expect(isSBlob(lazyResult.image)).toBe(true);
    expect(isSBlob(residentResult.image)).toBe(true);
    // Same ctx (same CAS) + identical rendered pixels → identical PNG hash.
    expect(lazyResult.image.hash).toBe(residentResult.image.hash);
  });

  it("getPreview on a lazy doc with NO ctx.cas throws (can't fault a PixelRef)", async () => {
    const { ctx } = memCas();
    const resident = residentDoc();
    const store = casBlobStore(ctx);
    const bytes = await serialize(resident, store);
    const lazyDoc = await deserialize(bytes, store);

    await expect(runQuery({ kind: "getPreview" }, lazyDoc)).rejects.toThrow(/BlobStore/);
  });

  it("apply flip on a lazy layer succeeds with ctx.cas and flips correctly", async () => {
    const { ctx } = memCas();
    const resident = residentDoc();
    const store = casBlobStore(ctx);
    const bytes = await serialize(resident, store);
    const lazyDoc = await deserialize(bytes, store);

    const ops = [{ kind: "transform", payload: { layerId: "top", op: { flip: "h" } } }];
    const flipped = await apply(ops, lazyDoc, ctx);

    const flippedTop = flipped.layers.find((l) => l.id === "top")!;
    expect(isRef(flippedTop.pixels!)).toBe(false);
    const data = (flippedTop.pixels as any).data as Uint8ClampedArray;
    // Post-flip: top-left should now be green (was top-right), top-right red.
    expect([data[0], data[1], data[2], data[3]]).toEqual([0, 255, 0, 255]);
    expect([data[4], data[5], data[6], data[7]]).toEqual([255, 0, 0, 255]);

    // Sibling ("bottom") layer stays lazy — only the flipped layer is faulted.
    const flippedBottom = flipped.layers.find((l) => l.id === "bottom")!;
    expect(isRef(flippedBottom.pixels!)).toBe(true);
  });

  it("apply flip on a lazy layer with NO ctx throws the loud PixelRef error", async () => {
    const { ctx } = memCas();
    const resident = residentDoc();
    const store = casBlobStore(ctx);
    const bytes = await serialize(resident, store);
    const lazyDoc = await deserialize(bytes, store);

    const ops = [{ kind: "transform", payload: { layerId: "top", op: { flip: "h" } } }];
    await expect(apply(ops, lazyDoc)).rejects.toThrow(
      /transform flip: pixels not resolved \(PixelRef\) — resolve before edit/
    );
  });
});
