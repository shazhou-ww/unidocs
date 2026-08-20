import { describe, it, expect } from "vitest";
import { cropPixelsToCanvas } from "../src/psd/load.js";

describe("cropPixelsToCanvas", () => {
  it("crops a layer that overflows the canvas", () => {
    // 4x4 layer at bounds [-1,-1,3,3] on a 2x2 canvas → clipped to [0,0,2,2], 2x2 px
    const data = new Uint8ClampedArray(4 * 4 * 4).fill(200);
    const out = cropPixelsToCanvas({ width: 4, height: 4, data }, [-1, -1, 3, 3], 2, 2);
    expect(out.bounds).toEqual([0, 0, 2, 2]);
    expect(out.pixels.width).toBe(2);
    expect(out.pixels.height).toBe(2);
  });
});
