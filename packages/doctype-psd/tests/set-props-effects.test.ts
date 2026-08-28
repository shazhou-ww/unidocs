import { describe, it, expect } from "vitest";
import type { PsdDoc } from "../src/model/types.js";
import { setProps } from "../src/ops/layer-ops.js";
import { applyOne } from "../src/ops/index.js";
import { opDirtyRect } from "../src/render/dirty-rect.js";
import { findLayer } from "../src/model/tree.js";

const base = {
  bounds: [8, 8, 24, 24] as [number, number, number, number],
  opacity: 1, blendMode: "normal" as const,
  visible: true, locked: false, clipping: false,
};
const doc = (): PsdDoc => ({
  canvas: { width: 64, height: 64, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
  layers: [{ id: "a", type: "raster", name: "a", ...base }],
});

const STROKE = {
  color: { r: 255, g: 0, b: 0 }, opacity: 1, size: 3,
  position: "outside" as const, blendMode: "normal" as const,
};
const SHADOW = {
  color: { r: 0, g: 0, b: 0 }, opacity: 0.5, blendMode: "normal" as const,
  angle: 0, distance: 10, size: 4, choke: 0,
};

describe("setProps — layer effects", () => {
  it("writes stroke", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { stroke: STROKE } });
    expect(findLayer(d.layers, "a")!.stroke).toEqual(STROKE);
  });

  it("writes colorOverlay", () => {
    const d = doc();
    const co = { r: 245, g: 239, b: 227, opacity: 0.8 };
    setProps(d, { layerId: "a", props: { colorOverlay: co } });
    expect(findLayer(d.layers, "a")!.colorOverlay).toEqual(co);
  });

  it("writes dropShadow", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { dropShadow: SHADOW } });
    expect(findLayer(d.layers, "a")!.dropShadow).toEqual(SHADOW);
  });

  it("writes fillOpacity", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { fillOpacity: 0.25 } });
    expect(findLayer(d.layers, "a")!.fillOpacity).toBe(0.25);
  });

  it("null removes an effect", () => {
    const d = doc();
    setProps(d, { layerId: "a", props: { stroke: STROKE } });
    setProps(d, { layerId: "a", props: { stroke: null } });
    expect(findLayer(d.layers, "a")!.stroke).toBeUndefined();
  });

  it("rejects an invalid stroke.position", () => {
    const d = doc();
    expect(() => setProps(d, { layerId: "a", props: { stroke: { ...STROKE, position: "middle" } } }))
      .toThrow(/stroke\.position/);
  });

  it("rejects stroke.opacity out of 0..1", () => {
    const d = doc();
    expect(() => setProps(d, { layerId: "a", props: { stroke: { ...STROKE, opacity: 255 } } }))
      .toThrow(/stroke\.opacity/);
  });

  it("rejects a colour component out of 0..255", () => {
    const d = doc();
    expect(() => setProps(d, { layerId: "a", props: { colorOverlay: { r: 300, g: 0, b: 0, opacity: 1 } } }))
      .toThrow(/colorOverlay/);
  });

  it("rejects fillOpacity out of 0..1", () => {
    const d = doc();
    expect(() => setProps(d, { layerId: "a", props: { fillOpacity: 2 } })).toThrow(/fillOpacity/);
  });

  // Pins the reason this task needs no render changes: influence bounds already
  // account for the shadow's offset + blur, and opDirtyRect unions before/after.
  it("dropShadow write produces a dirty rect covering the shadow bleed", () => {
    const before = doc();
    const op = { kind: "set_props", payload: { layerId: "a", props: { dropShadow: SHADOW } } };
    const after = applyOne(before, op);
    // bounds [8,8,24,24]; angle 0 / distance 10 → dx=-10, dy=0; grown by size+choke=4.
    expect(opDirtyRect(op, before, after)).toEqual([4, 0, 28, 24]);
  });
});
