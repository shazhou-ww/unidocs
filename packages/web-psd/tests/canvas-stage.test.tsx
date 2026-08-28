import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { StrictMode } from "react";

// DocController spins up a Web Worker and talks to the gateway; neither exists
// under jsdom. Mock the module so this test covers only the wiring contract:
// the canvas + its scrolling stage are handed to the controller exactly once.
const ctor = vi.fn();
vi.mock("../src/doc-controller.js", () => ({
  DocController: class {
    constructor(...args: unknown[]) { ctor(...args); }
    docId = null;
    createFrom = vi.fn(async () => {});
  },
  GW: "", USER: "u1", TYPE: "psd", API_BASE_URL: "/tenants/u1",
}));

beforeEach(() => { ctor.mockClear(); vi.unstubAllGlobals(); });

describe("CanvasStage", () => {
  it("hands the canvas and its scrolling stage to the controller once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })));
    const { CanvasStage } = await import("../src/ui/panels/canvas-stage.js");
    // StrictMode double-invokes effects on mount in development — the exact
    // scenario `initController`'s `if (controller) return` guard exists for.
    // A plain `rerender()` of the same element does NOT re-run a `[]`-dep
    // effect, so it alone cannot exercise that guard.
    const { container, rerender } = render(
      <StrictMode>
        <CanvasStage />
      </StrictMode>,
    );
    const view = container.querySelector("canvas.view");
    const stage = container.querySelector("div.stage");
    expect(view).toBeInTheDocument();
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0][0]).toBe(view);
    expect(ctor.mock.calls[0][1]).toBe(stage);
    rerender(
      <StrictMode>
        <CanvasStage />
      </StrictMode>,
    );
    expect(ctor).toHaveBeenCalledTimes(1); // idempotent
  });
});
