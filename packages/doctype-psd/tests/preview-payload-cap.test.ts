import { describe, it, expect } from "vitest";
import { decode } from "fast-png";
import { encodeSValue, isSBlob } from "@unidocs/svalue-codec";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { runQuery } from "../src/queries.js";
import { memCas } from "./helpers/mem-cas.js";

/**
 * The PNG now travels as a CAS-backed SBlob rather than an inline base64
 * string, so it no longer risks the codec's 1 MiB `maxStringBytes` cap
 * directly. But the byte budget that used to guard that cap (see
 * `fitToBudget` / `PREVIEW_BASE64_BUDGET` in queries.ts) is still worth
 * pinning here: it is what keeps a detailed document's preview from handing
 * the model tens of megabytes of image. These tests still simulate the
 * base64-equivalent size (what would have gone inline) from the PNG bytes
 * actually stored in the CAS, so the budget's numbers are unchanged —
 * only where the bytes live changed.
 *
 * The worst case is incompressible content: PNG cannot beat raw RGBA on random
 * noise, so `width * height * 4 * 4/3` bytes of base64 is the floor. These
 * tests use noise precisely so they pin the bound without depending on how
 * well some particular photo happens to deflate.
 */

const SVALUE_MAX_STRING_BYTES = 1024 * 1024;

/** Incompressible noise — the worst case for any image codec. */
function noiseLayer(id: string, w: number, h: number, seed: number): Layer {
  const data = new Uint8ClampedArray(w * h * 4);
  // xorshift32: deterministic, and statistically noisy enough that PNG's
  // filters + deflate cannot shrink it.
  let s = seed | 0 || 1;
  for (let i = 0; i < w * h; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    data[i * 4] = s & 0xff;
    data[i * 4 + 1] = (s >>> 8) & 0xff;
    data[i * 4 + 2] = (s >>> 16) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return {
    id, type: "raster", name: id, bounds: [0, 0, h, w], opacity: 1,
    blendMode: "normal", visible: true, locked: false, clipping: false,
    pixels: { width: w, height: h, data },
  } as unknown as Layer;
}

const noiseDoc = (w: number, h: number): PsdDoc => ({
  canvas: { width: w, height: h, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [noiseLayer("noise", w, h, 12345)],
} as unknown as PsdDoc);

/** Pull the actual PNG bytes for a preview result's SBlob out of the CAS. */
function pngBytesOf(out: any, nodes: Map<string, Uint8Array>): Uint8Array {
  if (!isSBlob(out.image)) throw new Error("getPreview result has no SBlob image");
  const bytes = nodes.get(out.image.hash);
  if (!bytes) throw new Error(`CAS node ${out.image.hash} not found`);
  return bytes;
}

/** The check that actually matters: can the runtime encode this result at all? */
function expectEncodable(out: any, nodes: Map<string, Uint8Array>, label: string): void {
  const png = pngBytesOf(out, nodes);
  const base64EquivalentBytes = Math.ceil(png.length / 3) * 4;
  expect(
    base64EquivalentBytes,
    `${label}: base64-equivalent is ${(base64EquivalentBytes / 1024).toFixed(0)} KiB`,
  ).toBeLessThanOrEqual(SVALUE_MAX_STRING_BYTES);
  // `out.image` is now just an SBlob reference (a hash string), so this can
  // no longer hit the old base64-overflow 500 — that risk is gone by
  // construction. What's still worth pinning: the result value itself
  // (SBlob ref + width/height/region) round-trips through the real codec.
  expect(() => encodeSValue(out), `${label}: encodeSValue`).not.toThrow();
}

describe("getPreview payload stays inside the SValue string cap", () => {
  it("full-canvas preview of a large detailed document", async () => {
    const { ctx, nodes } = memCas();
    const out = await runQuery({ kind: "getPreview" }, noiseDoc(3556, 2000), ctx) as any;
    expectEncodable(out, nodes, "full canvas, default maxSize");
    const img = decode(pngBytesOf(out, nodes));
    expect(img.width).toBe(out.width);
    expect(img.height).toBe(out.height);
  }, 120_000);

  it("rect preview, whose default cap is the larger 1536", async () => {
    const { ctx, nodes } = memCas();
    const out = await runQuery(
      { kind: "getPreview", payload: { rect: [0, 0, 2000, 3556] } },
      noiseDoc(3556, 2000),
      ctx,
    ) as any;
    expectEncodable(out, nodes, "rect, default maxSize");
  }, 120_000);

  it("an explicit oversized maxSize is still capped, not honoured into a 500", async () => {
    const { ctx, nodes } = memCas();
    const out = await runQuery(
      { kind: "getPreview", payload: { maxSize: 4096 } },
      noiseDoc(3556, 2000),
      ctx,
    ) as any;
    expectEncodable(out, nodes, "explicit maxSize=4096");
  }, 120_000);

  it("a square document (worst aspect ratio for a dimension-based cap)", async () => {
    const { ctx, nodes } = memCas();
    const out = await runQuery({ kind: "getPreview" }, noiseDoc(2048, 2048), ctx) as any;
    expectEncodable(out, nodes, "square canvas");
  }, 120_000);

  it("single-layer preview", async () => {
    const { ctx, nodes } = memCas();
    const out = await runQuery(
      { kind: "getPreview", payload: { layerId: "noise" } },
      noiseDoc(3000, 1800),
      ctx,
    ) as any;
    expectEncodable(out, nodes, "layerId preview");
  }, 120_000);

  it("leaves small previews completely untouched", async () => {
    const { ctx, nodes } = memCas();
    const doc = noiseDoc(64, 48);
    const out = await runQuery({ kind: "getPreview" }, doc, ctx) as any;
    expectEncodable(out, nodes, "small doc");
    // Well under the cap → must come back at native size, not shrunk.
    expect([out.width, out.height]).toEqual([64, 48]);
    const img = decode(pngBytesOf(out, nodes));
    expect([img.width, img.height]).toEqual([64, 48]);
    expect([...img.data.slice(0, 4)]).toEqual([...doc.layers[0].pixels!.data.slice(0, 4)]);
  });

  it("honours a small explicit maxSize exactly (no surprise extra shrinking)", async () => {
    const { ctx } = memCas();
    const out = await runQuery(
      { kind: "getPreview", payload: { maxSize: 128 } },
      noiseDoc(3556, 2000),
      ctx,
    ) as any;
    expect(Math.max(out.width, out.height)).toBe(128);
  }, 120_000);
});
