import { describe, it, expect } from "vitest";
import { decode } from "fast-png";
import { encodeSValue } from "@unidocs/svalue-codec";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { runQuery } from "../src/queries.js";

/**
 * A `getPreview` result travels back as an SValue, and the base64 image rides
 * in an ordinary string — which the codec caps at 1 MiB (`maxStringBytes`).
 * A detailed document blows straight past that and the whole query 500s with
 * `string exceeds 1048576 UTF-8 bytes`, so the agent's most-used tool fails on
 * exactly the documents it is most needed for.
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

/** The check that actually matters: can the runtime encode this result at all? */
function expectEncodable(out: any, label: string): void {
  const b64 = out.$image.base64 as string;
  const bytes = new TextEncoder().encode(b64).length;
  expect(bytes, `${label}: base64 is ${(bytes / 1024).toFixed(0)} KiB`).toBeLessThanOrEqual(SVALUE_MAX_STRING_BYTES);
  // Belt and braces — run it through the real codec, which is what 500s today.
  expect(() => encodeSValue(out), `${label}: encodeSValue`).not.toThrow();
}

describe("getPreview payload stays inside the SValue string cap", () => {
  it("full-canvas preview of a large detailed document", async () => {
    const out = await runQuery({ kind: "getPreview" }, noiseDoc(3556, 2000)) as any;
    expectEncodable(out, "full canvas, default maxSize");
    const img = decode(new Uint8Array(Buffer.from(out.$image.base64, "base64")));
    expect(img.width).toBe(out.width);
    expect(img.height).toBe(out.height);
  }, 120_000);

  it("rect preview, whose default cap is the larger 1536", async () => {
    const out = await runQuery(
      { kind: "getPreview", payload: { rect: [0, 0, 2000, 3556] } },
      noiseDoc(3556, 2000),
    ) as any;
    expectEncodable(out, "rect, default maxSize");
  }, 120_000);

  it("an explicit oversized maxSize is still capped, not honoured into a 500", async () => {
    const out = await runQuery(
      { kind: "getPreview", payload: { maxSize: 4096 } },
      noiseDoc(3556, 2000),
    ) as any;
    expectEncodable(out, "explicit maxSize=4096");
  }, 120_000);

  it("a square document (worst aspect ratio for a dimension-based cap)", async () => {
    const out = await runQuery({ kind: "getPreview" }, noiseDoc(2048, 2048)) as any;
    expectEncodable(out, "square canvas");
  }, 120_000);

  it("single-layer preview", async () => {
    const out = await runQuery(
      { kind: "getPreview", payload: { layerId: "noise" } },
      noiseDoc(3000, 1800),
    ) as any;
    expectEncodable(out, "layerId preview");
  }, 120_000);

  it("leaves small previews completely untouched", async () => {
    const doc = noiseDoc(64, 48);
    const out = await runQuery({ kind: "getPreview" }, doc) as any;
    expectEncodable(out, "small doc");
    // Well under the cap → must come back at native size, not shrunk.
    expect([out.width, out.height]).toEqual([64, 48]);
    const img = decode(new Uint8Array(Buffer.from(out.$image.base64, "base64")));
    expect([img.width, img.height]).toEqual([64, 48]);
    expect([...img.data.slice(0, 4)]).toEqual([...doc.layers[0].pixels!.data.slice(0, 4)]);
  });

  it("honours a small explicit maxSize exactly (no surprise extra shrinking)", async () => {
    const out = await runQuery(
      { kind: "getPreview", payload: { maxSize: 128 } },
      noiseDoc(3556, 2000),
    ) as any;
    expect(Math.max(out.width, out.height)).toBe(128);
  }, 120_000);
});
