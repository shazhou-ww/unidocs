import { describe, it, expect } from "vitest";
import { writePsd } from "ag-psd";
import { load, cropPixelsToCanvas } from "../src/psd/load.js";
import { installCanvasShim } from "../src/psd/canvas-shim.js";

describe("cropPixelsToCanvas", () => {
  it("crops a layer that overflows the canvas", () => {
    // 4x4 layer at bounds [-1,-1,3,3] on a 2x2 canvas → clipped to [0,0,2,2], 2x2 px
    const data = new Uint8ClampedArray(4 * 4 * 4).fill(200);
    const out = cropPixelsToCanvas({ width: 4, height: 4, data }, [-1, -1, 3, 3], 2, 2);
    expect(out.bounds).toEqual([0, 0, 2, 2]);
    expect(out.pixels.width).toBe(2);
    expect(out.pixels.height).toBe(2);
  });

  it("clips a fully off-canvas layer to a degenerate, non-inverted rect", () => {
    // Entirely to the bottom-right of a 2x2 canvas.
    const data = new Uint8ClampedArray(4 * 4 * 4).fill(100);
    const out = cropPixelsToCanvas({ width: 4, height: 4, data }, [5, 5, 10, 10], 2, 2);
    expect(out.bounds).toEqual([5, 5, 5, 5]); // [nt,nl,nt,nl] — not inverted
    expect(out.pixels.width).toBe(0);
    expect(out.pixels.height).toBe(0);

    // Entirely to the top-left of a 2x2 canvas.
    const data2 = new Uint8ClampedArray(5 * 5 * 4).fill(50);
    const out2 = cropPixelsToCanvas({ width: 5, height: 5, data: data2 }, [-10, -10, -5, -5], 2, 2);
    expect(out2.bounds).toEqual([0, 0, 0, 0]); // [nt,nl,nt,nl] — not inverted
    expect(out2.pixels.width).toBe(0);
    expect(out2.pixels.height).toBe(0);
  });

  it("is a no-op (same pixels object, no copy) for a layer already within the canvas", () => {
    const data = new Uint8ClampedArray(2 * 2 * 4).fill(10);
    const px = { width: 2, height: 2, data };
    const out = cropPixelsToCanvas(px, [0, 0, 2, 2], 4, 4);
    expect(out.pixels).toBe(px);
    expect(out.bounds).toEqual([0, 0, 2, 2]);
  });
});

describe("load() crop integration", () => {
  it("leaves an overflowing layer with a stroke effect uncropped", async () => {
    installCanvasShim();
    const cw = 4, ch = 4;
    const layerW = 10, layerH = 10;
    const top = -3, left = -3;
    const psd = {
      width: cw,
      height: ch,
      imageData: { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) },
      children: [
        {
          name: "stroked",
          top, left, bottom: top + layerH, right: left + layerW,
          imageData: { width: layerW, height: layerH, data: new Uint8ClampedArray(layerW * layerH * 4).fill(128) },
          effects: {
            stroke: [{
              enabled: true, fillType: "color" as const, position: "outside" as const,
              color: { r: 255, g: 0, b: 0 }, size: { value: 2, units: "Pixels" as const }, opacity: 1,
            }],
          },
        },
      ],
    };
    const bytes = writePsd(psd as any, { generateThumbnail: false, psb: false });
    const doc = await load(new Uint8Array(bytes));

    const layer = doc.layers[0];
    expect(layer.stroke).toBeDefined();
    // Bounds and pixel dimensions must be untouched — cropping this layer
    // would corrupt strokeEffect's chamfer distance transform, which reads
    // the pixel buffer beyond its own bounds (see task-0-report.md).
    expect(layer.bounds).toEqual([top, left, top + layerH, left + layerW]);
    expect(layer.pixels?.width).toBe(layerW);
    expect(layer.pixels?.height).toBe(layerH);
  });

  it("crops an overflowing layer with no stroke/dropShadow effect", async () => {
    installCanvasShim();
    const cw = 4, ch = 4;
    const layerW = 10, layerH = 10;
    const top = -3, left = -3;
    const psd = {
      width: cw,
      height: ch,
      imageData: { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) },
      children: [
        {
          name: "plain",
          top, left, bottom: top + layerH, right: left + layerW,
          imageData: { width: layerW, height: layerH, data: new Uint8ClampedArray(layerW * layerH * 4).fill(128) },
        },
      ],
    };
    const bytes = writePsd(psd as any, { generateThumbnail: false, psb: false });
    const doc = await load(new Uint8Array(bytes));

    const layer = doc.layers[0];
    expect(layer.stroke).toBeUndefined();
    expect(layer.bounds).toEqual([0, 0, ch, cw]);
    expect(layer.pixels?.width).toBe(cw);
    expect(layer.pixels?.height).toBe(ch);
  });
});
