import { describe, it, expect } from "vitest";
import type { PsdDoc, Layer } from "../src/model/types.js";
import { runQuery } from "../src/queries.js";

const raster = (id: string): Layer => ({
  id, type: "raster", name: id, bounds: [0, 0, 2, 2], opacity: 1, blendMode: "normal",
  visible: true, locked: false, clipping: false, pixels: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
});
const doc = (): PsdDoc => ({ canvas: { width: 2, height: 2, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" }, layers: [raster("a"), raster("b")] });

describe("getDoc", () => {
  it("returns structure with pixel data stripped", async () => {
    const out = await runQuery({ kind: "getDoc" }, doc()) as any;
    expect(out.canvas.width).toBe(2);
    expect(out.layers).toHaveLength(2);
    expect(out.layers[0].pixels).toEqual({ width: 2, height: 2, omitted: true });
    expect(out.layers[0].pixels.data).toBeUndefined();
  });

  it("returns just one layer when layerId is given", async () => {
    const out = await runQuery({ kind: "getDoc", payload: { layerId: "b" } }, doc()) as any;
    expect(out.layers).toHaveLength(1);
    expect(out.layers[0].id).toBe("b");
  });
});
