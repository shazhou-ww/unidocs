import { describe, it, expect } from "vitest";
import { getState, setState, nextSelection } from "../src/ui/store.js";
import { translateOps } from "../src/ui/drag.js";
import type { LocalLayer } from "../src/doc-model.js";

const leaf = (id: string): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds: [0, 0, 10, 10] });

describe("selection normalization end-to-end", () => {
  it("dispatches ONE translate for a child whose group is already selected", () => {
    setState({
      doc: { canvas: { width: 100, height: 100 }, layers: [
        { id: "g", type: "group", name: "g", opacity: 1, blendMode: "normal", visible: true,
          bounds: [0, 0, 0, 0], children: [leaf("b")] },
      ] },
      selection: ["g"],
    });
    // Shift-clicking the child of an already-selected group is the ordinary
    // path once canvas click-select lands, not an exotic one. Un-normalized,
    // this yields ["g","b"] and geometry-ops' recursive shiftLayer moves "b"
    // by the group's translate AND by its own.
    const selection = nextSelection(getState(), "b", true);
    expect(selection).toEqual(["g"]);

    const ops = translateOps({ layerIds: selection, from: { x: 0, y: 0 }, last: { x: 0, y: 0 } }, { x: 5, y: 0 });
    expect(ops.map((o) => o.payload.layerId)).toEqual(["g"]);
  });
});
