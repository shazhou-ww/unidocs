import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { App } from "../src/ui/app.js";
import { setState, getState } from "../src/ui/store.js";

/**
 * Exercises the REAL ui/controller.js + zoom-controller.js wiring. Every other
 * zoom test mocks ui/controller.js, so the actual module graph — which is
 * circular: controller -> zoom-controller -> controller — has never been
 * evaluated under test. Only doc-controller is faked, because it needs a
 * Worker and the gateway.
 */
const stageBox = { left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 };

vi.mock("../src/doc-controller.js", () => ({
  DocController: class {
    docId: string | null = "doc-1";
    createFrom = vi.fn(async () => {});
    requestVisibleTiles = vi.fn();
    dispatch = vi.fn(async () => {});
    canvasRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });
    toCanvas = (x: number, y: number) => ({ x: x / getState().zoom, y: y / getState().zoom });
    toScreen = (x: number, y: number) => ({ x: x * getState().zoom, y: y * getState().zoom });
    pickColor = () => null;
    stage = { clientWidth: 1000, clientHeight: 800, scrollLeft: 0, scrollTop: 0,
              getBoundingClientRect: () => stageBox };
  },
  GW: "", USER: "u1", TYPE: "psd", API_BASE_URL: "/tenants/u1",
}));

let frames: Array<() => void> = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in test"); }));
  setState({ zoom: 1, tool: "marquee", marquee: null, selection: [], chat: [], history: [],
             doc: { canvas: { width: 2000, height: 1000 }, layers: [] } as never });
});
afterEach(() => { vi.unstubAllGlobals(); });

const runFrame = (): void => { const fs = frames; frames = []; for (const f of fs) f(); };

describe("zoom wiring through the real controller modules", () => {
  it("zooms on ctrl+wheel over the stage", () => {
    const { container } = render(<App />);
    fireEvent.wheel(container.querySelector(".stage")!,
                    { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 200 });
    runFrame();
    expect(getState().zoom).toBeGreaterThan(1);
  });

  it("zooms on meta+wheel too", () => {
    const { container } = render(<App />);
    fireEvent.wheel(container.querySelector(".stage")!,
                    { deltaY: -100, metaKey: true, clientX: 300, clientY: 200 });
    runFrame();
    expect(getState().zoom).toBeGreaterThan(1);
  });

  it("fits on meta+0 and goes to 100% on meta+1", () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "0", metaKey: true });
    expect(getState().zoom).toBeCloseTo(0.484, 3); // 2000 wide into 968 usable
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(getState().zoom).toBe(1);
  });

  it("steps on meta+= and meta+-", () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "=", metaKey: true });
    expect(getState().zoom).toBeCloseTo(1.5);
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    expect(getState().zoom).toBeCloseTo(1);
  });
});
