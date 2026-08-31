import { describe, it, expect, beforeEach } from "vitest";
import {
  getState, setState, subscribe,
  toggleExpanded, nextSelection, opsSinceSession, selectedLayers,
  type UiState,
} from "../src/ui/store.js";
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
    selection: [], expanded: new Set(), tool: "move",
    marquee: null, zoom: 1, history: [], historyOpen: false,
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
