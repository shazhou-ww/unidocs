import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readPsd } from "ag-psd";
import type { PsdDoc } from "../src/model/types.js";
import { save } from "../src/psd/save.js";
import { load } from "../src/psd/load.js";
import { render } from "../src/render/composite.js";
import { installCanvasShim } from "../src/psd/canvas-shim.js";

/** Re-reads a saved PSD, keeping ONLY the flattened composite — the image
 *  data section every viewer outside Photoshop actually draws. */
function compositeOf(bytes: Uint8Array): { width: number; height: number; data: Uint8ClampedArray } {
  installCanvasShim();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const psd = readPsd(buf, { useImageData: true, skipLayerImageData: true, skipThumbnail: true });
  const img = psd.imageData;
  if (!img) throw new Error("saved PSD has no composite image data");
  return { width: img.width, height: img.height, data: img.data as Uint8ClampedArray };
}

const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
};

const flatDoc = (): PsdDoc => ({
  canvas: { width: 4, height: 4, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [{
    id: "bg", type: "raster", name: "bg", bounds: [0, 0, 4, 4],
    opacity: 1, blendMode: "normal", visible: true, locked: false, clipping: false,
    pixels: solid(4, 4, [200, 30, 40, 255]),
  }],
});

describe("save 写出真正的合成图层（image data section）", () => {
  // The PSD image data section is what Finder/Preview, browsers and every
  // thumbnailer draw; Photoshop is the only common reader that composes the
  // layers itself. Writing a zero-filled buffer there made an export whose
  // layers were intact open as a blank white image everywhere else.
  it("单个不透明图层的合成图就是该图层的像素，不是空白", async () => {
    const composite = compositeOf(await save(flatDoc()));
    expect(composite.width).toBe(4);
    expect(composite.height).toBe(4);
    expect(Array.from(composite.data.slice(0, 4))).toEqual([200, 30, 40, 255]);
    expect(composite.data.some((b) => b !== 0)).toBe(true);
  });

  it("真实文件的合成图与渲染器的输出一致", async () => {
    const bytes = new Uint8Array(readFileSync(new URL("./fixtures/sample.psd", import.meta.url)));
    const doc = await load(bytes);
    const expected = await render(doc);
    const composite = compositeOf(await save(doc));
    expect(composite.width).toBe(expected.width);
    expect(composite.height).toBe(expected.height);
    // Compare by counting mismatches rather than deep-equalling 260k entries:
    // a failing deep equal on an array that size takes minutes to diff.
    let mismatches = 0;
    for (let i = 0; i < expected.data.length; i++) {
      if (composite.data[i] !== expected.data[i]) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});
