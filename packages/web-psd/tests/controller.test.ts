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
  },
  GW: "", USER: "u1", TYPE: "psd", API_BASE_URL: "/tenants/u1",
}));

beforeEach(() => {
  vi.resetModules();
  // Cold start's own fetch (`bootstrap`) must fail harmlessly and never
  // touch `docsQueue` — these tests drive document loads explicitly via
  // `openFile` instead.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in test"); }));
  capturedEvents = undefined;
  docsQueue = [];
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
