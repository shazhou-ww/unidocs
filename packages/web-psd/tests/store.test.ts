import { describe, it, expect, beforeEach } from "vitest";
import {
  getState, setState, subscribe,
  toggleExpanded, nextSelection, opsSinceSession, selectedLayers, setRegion,
  type UiState,
} from "../src/ui/store.js";
import { getMask, putMask } from "../src/ui/region.js";
import type { LocalLayer } from "../src/doc-model.js";

const leaf = (id: string, children?: LocalLayer[]): LocalLayer => ({
  id, type: children ? "group" : "raster", name: id,
  opacity: 1, blendMode: "normal", visible: true, ...(children ? { children } : {}),
});

const withDoc = (): UiState => {
  setState({ doc: { canvas: { width: 4, height: 4 }, layers: [leaf("g", [leaf("b")]), leaf("a")] } });
  return getState();
};

beforeEach(() => {
  setState({
    docId: null, docName: null, version: 0, doc: null, status: "",
    selection: [], expanded: new Set(), pane: "layers", tool: "move",
    region: null, zoom: 1, history: [], historyOpen: false,
    sessionBaseVersion: 0, chat: [], chatBusy: false, degradeOpen: false,
    pickedColor: null,
  });
});

describe("store subscription", () => {
  it("notifies subscribers and swaps the snapshot identity on change", () => {
    let calls = 0;
    const before = getState();
    const off = subscribe(() => { calls += 1; });
    setState({ status: "loading" });
    expect(calls).toBe(1);
    expect(getState()).not.toBe(before);
    expect(getState().status).toBe("loading");
    off();
    setState({ status: "done" });
    expect(calls).toBe(1);
  });
});

describe("toggleExpanded", () => {
  it("adds then removes an id without mutating the previous set", () => {
    const s = getState();
    const opened = toggleExpanded(s, "g");
    expect(opened.has("g")).toBe(true);
    expect(s.expanded.has("g")).toBe(false);
    expect(toggleExpanded({ ...s, expanded: opened }, "g").has("g")).toBe(false);
  });
});

describe("nextSelection", () => {
  it("replaces the selection by default", () => {
    const s = { ...getState(), selection: ["a"] };
    expect(nextSelection(s, "b", false)).toEqual(["b"]);
  });

  it("adds on additive click and removes on additive re-click", () => {
    const s = { ...getState(), selection: ["a"] };
    expect(nextSelection(s, "b", true)).toEqual(["a", "b"]);
    expect(nextSelection({ ...s, selection: ["a", "b"] }, "a", true)).toEqual(["b"]);
  });
});

describe("opsSinceSession", () => {
  it("keeps only entries newer than the version the page opened at", () => {
    const h = [3, 4, 5].map((v) => ({ version: v, timestamp: "", description: "", operations: [] }));
    const s = { ...getState(), history: h, sessionBaseVersion: 3 };
    expect(opsSinceSession(s).map((e) => e.version)).toEqual([4, 5]);
  });
});

describe("selectedLayers", () => {
  it("resolves ids through nested groups, skipping unknown ids", () => {
    const s = { ...withDoc(), selection: ["b", "nope", "a"] };
    expect(selectedLayers(s).map((l) => l.id)).toEqual(["b", "a"]);
  });
});

// setRegion is the one write point for the region axis specifically because
// it also owns the mask sweep (region.ts's module-level table). Exercised
// here through the real function, not by calling sweepMasks directly — a
// regression that re-inlined `setState({ region })` somewhere would still
// leave these green if the mask assertions weren't tied to setRegion itself.
describe("setRegion", () => {
  it("frees the previous mask's bytes when a new region replaces it", () => {
    setRegion({ bounds: [0, 0, 2, 2], source: "layerAlpha", maskId: putMask(new Uint8ClampedArray([1, 2])) });
    const first = getState().region!.maskId;
    expect(getMask(first)).not.toBeNull();

    setRegion({ bounds: [0, 0, 3, 3], source: "layerAlpha", maskId: putMask(new Uint8ClampedArray([3, 4])) });
    expect(getMask(first)).toBeNull();
    expect(getMask(getState().region!.maskId)).toEqual(new Uint8ClampedArray([3, 4]));
  });

  it("frees the mask when the region is cleared to null", () => {
    setRegion({ bounds: [0, 0, 2, 2], source: "layerAlpha", maskId: putMask(new Uint8ClampedArray([9])) });
    const id = getState().region!.maskId;
    setRegion(null);
    expect(getState().region).toBeNull();
    expect(getMask(id)).toBeNull();
  });
});
