import { describe, it, expect, vi, beforeEach } from "vitest";

// DocController never runs under jsdom (spins a Worker + talks to the
// gateway). This mock drives `ui/controller.ts`'s onDoc/createFrom
// orchestration directly: `docsQueue` supplies the (docId, version) pair
// each `createFrom` call "loads", mirroring the real DocController setting
// its `docId` field before firing `onDoc` (see doc-controller.ts's
// createFrom -> initRender). An empty queue simulates a failed create:
// the real DocController swallows creation errors internally and never
// fires `onDoc` (see doc-controller.ts's createFrom catch block).
let capturedEvents: { onDoc: (doc: unknown, version: number) => void; onStatus: (s: string) => void } | undefined;
let docsQueue: Array<{ docId: string; version: number }> = [];
// `loadLayerAsRegion`'s read path — set per test to simulate a real hit
// (a coverage buffer) or the no-extent case (an adjustment layer).
let layerAlphaResult: { bounds: [number, number, number, number]; data: Uint8ClampedArray } | null = null;

// jsdom's `File` has no working `arrayBuffer()`; `openFile` only reads
// `.name` and `.arrayBuffer()`, so a minimal fake stands in for a real File.
function fakeFile(name: string): File {
  return { name, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
}

vi.mock("../src/doc-controller.js", () => ({
  DocController: class {
    docId: string | null = null;
    constructor(_view: unknown, _stage: unknown, events: typeof capturedEvents) {
      capturedEvents = events;
    }
    // Zoom reads the stage box and nudges the controller to refetch tiles.
    requestVisibleTiles = vi.fn();
    stage = { clientWidth: 1000, clientHeight: 800 } as unknown as HTMLElement;
    createFrom = vi.fn(async function (this: { docId: string | null }) {
      const next = docsQueue.shift();
      if (!next) return;
      this.docId = next.docId;
      capturedEvents?.onDoc({ canvas: { width: 1, height: 1 }, layers: [] }, next.version);
    });
    layerAlphaRegion = vi.fn(async () => layerAlphaResult);
  },
  GW: "", USER: "u1", TYPE: "psd", API_BASE_URL: "/tenants/u1",
}));

beforeEach(() => {
  vi.resetModules();
  // Startup opens nothing, so nothing here should reach the network at all —
  // a stub that throws turns any regression that reintroduces a cold-start
  // fetch into a visible failure rather than a silent request.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in test"); }));
  capturedEvents = undefined;
  docsQueue = [];
  layerAlphaResult = null;
});

describe("controller: startup", () => {
  it("opens no document, leaving the editor in its empty state", async () => {
    // Auto-loading a bundled sample meant the editor was never seen empty and
    // the first document a user opened was always a replacement of something.
    docsQueue = [{ docId: "doc-a", version: 3 }];
    const { initController } = await import("../src/ui/controller.js");
    const { getState } = await import("../src/ui/store.js");

    initController(document.createElement("canvas"), document.createElement("div"));
    await Promise.resolve();

    expect(getState().docId).toBeNull();
    expect(getState().doc).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(docsQueue).toHaveLength(1); // untouched
  });
});

describe("controller: sessionBaseVersion boundary", () => {
  it("moves the boundary when a second document is opened, not just once per page load", async () => {
    docsQueue = [{ docId: "doc-a", version: 3 }, { docId: "doc-b", version: 7 }];
    const { initController, openFile } = await import("../src/ui/controller.js");
    const { getState } = await import("../src/ui/store.js");

    initController(document.createElement("canvas"), document.createElement("div"));

    await openFile(fakeFile("a.psd"));
    expect(getState().docId).toBe("doc-a");
    expect(getState().sessionBaseVersion).toBe(3);

    // A SECOND, unrelated document must move the boundary to its own
    // version — it must not stay pinned to the page's first document.
    await openFile(fakeFile("b.psd"));
    expect(getState().docId).toBe("doc-b");
    expect(getState().sessionBaseVersion).toBe(7);
  });
});

describe("controller: failed create", () => {
  it("leaves docId/docName untouched when a create produces no docId", async () => {
    docsQueue = [{ docId: "doc-a", version: 3 }];
    const { initController, openFile } = await import("../src/ui/controller.js");
    const { getState } = await import("../src/ui/store.js");

    initController(document.createElement("canvas"), document.createElement("div"));
    await openFile(fakeFile("a.psd"));
    expect(getState().docId).toBe("doc-a");
    expect(getState().docName).toBe("a.psd");

    // docsQueue is now empty, so this create "fails" (mirrors
    // DocController.createFrom silently reporting failure via onStatus and
    // never producing a docId) — the store must keep showing the document
    // that is actually still on screen, not the failed one's label.
    await openFile(fakeFile("broken.psd"));
    expect(getState().docId).toBe("doc-a");
    expect(getState().docName).toBe("a.psd");
  });
});

// setRegion is supposed to be the ONLY place a region is written, precisely
// because it also owns the mask sweep — but `onDoc`'s fresh-document and
// canvas-resize branches used to clear `region` through a raw `setState`
// that bypassed it, leaking the outgoing mask's bytes. These drive that
// through the real `ui/controller.ts` wiring (not by calling `sweepMasks`
// directly), so a regression that reintroduces the bypass fails here.
describe("controller: mask lifecycle", () => {
  it("sweeps the previous document's mask when a new document opens", async () => {
    docsQueue = [{ docId: "doc-a", version: 3 }, { docId: "doc-b", version: 5 }];
    layerAlphaResult = { bounds: [0, 0, 2, 2], data: new Uint8ClampedArray([1, 2, 3, 4]) };
    const { initController, openFile, loadLayerAsRegion } = await import("../src/ui/controller.js");
    const { getState } = await import("../src/ui/store.js");
    const { getMask } = await import("../src/ui/region.js");

    initController(document.createElement("canvas"), document.createElement("div"));
    await openFile(fakeFile("a.psd"));
    await loadLayerAsRegion("layer-1");
    const staleMaskId = getState().region!.maskId;
    expect(getMask(staleMaskId)).not.toBeNull();

    await openFile(fakeFile("b.psd"));
    expect(getState().region).toBeNull();
    expect(getMask(staleMaskId)).toBeNull();
  });

  it("sweeps the mask when the canvas resizes under the same document", async () => {
    docsQueue = [{ docId: "doc-a", version: 3 }];
    layerAlphaResult = { bounds: [0, 0, 2, 2], data: new Uint8ClampedArray([5, 6, 7, 8]) };
    const { initController, openFile, loadLayerAsRegion } = await import("../src/ui/controller.js");
    const { getState } = await import("../src/ui/store.js");
    const { getMask } = await import("../src/ui/region.js");

    initController(document.createElement("canvas"), document.createElement("div"));
    await openFile(fakeFile("a.psd")); // mock's onDoc reports a 1x1 canvas
    await loadLayerAsRegion("layer-1");
    const staleMaskId = getState().region!.maskId;
    expect(getMask(staleMaskId)).not.toBeNull();

    // Same docId, a different canvas size — a crop or agent resize, fired
    // straight through the captured onDoc callback the way DocController's
    // onRebase would, not a fresh open.
    capturedEvents?.onDoc({ canvas: { width: 5, height: 5 }, layers: [] }, 4);

    expect(getState().region).toBeNull();
    expect(getMask(staleMaskId)).toBeNull();
  });
});

describe("controller: loadLayerAsRegion", () => {
  it("loads a real layer's alpha as the region", async () => {
    docsQueue = [{ docId: "doc-a", version: 3 }];
    layerAlphaResult = { bounds: [1, 2, 3, 4], data: new Uint8ClampedArray([9, 9, 9, 9]) };
    const { initController, openFile, loadLayerAsRegion } = await import("../src/ui/controller.js");
    const { getState } = await import("../src/ui/store.js");
    const { getMask } = await import("../src/ui/region.js");

    initController(document.createElement("canvas"), document.createElement("div"));
    await openFile(fakeFile("a.psd"));

    await loadLayerAsRegion("layer-1");
    const region = getState().region!;
    expect(region.bounds).toEqual([1, 2, 3, 4]);
    expect(region.source).toBe("layerAlpha");
    expect(getMask(region.maskId)).toEqual(new Uint8ClampedArray([9, 9, 9, 9]));
  });

  // layerAlphaRegion returns null for a layer with no extent (an adjustment
  // layer, most notably — the very case this task's brief names as the
  // reason a layer→region conversion exists at all). The button isn't
  // disabled ahead of time, so this must not be a silent no-op.
  it("reports an error instead of silently doing nothing for a layer with no pixels", async () => {
    docsQueue = [{ docId: "doc-a", version: 3 }];
    layerAlphaResult = null;
    const { initController, openFile, loadLayerAsRegion } = await import("../src/ui/controller.js");
    const { getState } = await import("../src/ui/store.js");

    initController(document.createElement("canvas"), document.createElement("div"));
    await openFile(fakeFile("a.psd"));

    await loadLayerAsRegion("adj-1");
    expect(getState().region).toBeNull();
    expect(getState().status).toContain("载入选区失败");
    expect(getState().chat.at(-1)?.role).toBe("err");
    expect(getState().chat.at(-1)?.text).toContain("载入选区失败");
  });
});
