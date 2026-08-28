import { describe, it, expect } from "vitest";
import { translateOps, type DragState } from "../src/ui/drag.js";

const drag = (last: { x: number; y: number }): DragState =>
  ({ layerIds: ["a", "b"], from: { x: 10, y: 10 }, last });

describe("translateOps", () => {
  it("emits one op per layer with the delta since the last frame", () => {
    expect(translateOps(drag({ x: 10, y: 10 }), { x: 22, y: 4 })).toEqual([
      { kind: "transform", payload: { layerId: "a", op: { translate: [12, -6] } } },
      { kind: "transform", payload: { layerId: "b", op: { translate: [12, -6] } } },
    ]);
  });

  it("rounds to whole pixels and drops sub-pixel moves entirely", () => {
    expect(translateOps(drag({ x: 10, y: 10 }), { x: 10.4, y: 10.4 })).toEqual([]);
    expect(translateOps(drag({ x: 10, y: 10 }), { x: 11.6, y: 10 })).toEqual([
      { kind: "transform", payload: { layerId: "a", op: { translate: [2, 0] } } },
      { kind: "transform", payload: { layerId: "b", op: { translate: [2, 0] } } },
    ]);
  });
});
