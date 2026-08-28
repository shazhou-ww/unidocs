import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { CanvasStage } from "../src/ui/panels/canvas-stage.js";
import { setState } from "../src/ui/store.js";

// Regression guard for the mispositioned-marquee bug: SelectionOverlay's
// `position: absolute` marquee must resolve against the SAME positioned
// ancestor that shrink-wraps the canvas (`.stage-inner`), not against
// `.stage` itself — `.stage` can be larger than the canvas (it centres the
// canvas via `.stage-inner { margin: auto }` whenever the doc is smaller
// than the viewport), so if the overlay's containing block were `.stage`
// instead of `.stage-inner`, `toScreen()`'s canvas-relative coordinates
// would land in the wrong place. jsdom cannot check actual pixel
// positions (getBoundingClientRect is always zero), so this test asserts
// the DOM-structural invariant that makes the CSS correct by construction:
// canvas.view and .marquee must share the same parent element, and that
// parent must be `.stage-inner`. A future refactor that re-parents the
// overlay back to be a direct child of `.stage` (sibling of `.stage-inner`)
// fails this test even though jsdom can't see the visual symptom.
vi.mock("../src/ui/controller.js", () => ({
  initController: vi.fn(),
  getController: () => ({
    toCanvas: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
  }),
}));

beforeEach(() => {
  setState({ tool: "move", marquee: null, selection: [], pickedColor: null });
});

describe("CanvasStage + SelectionOverlay structure", () => {
  it("mounts the canvas and the marquee overlay under the same positioned parent (.stage-inner)", () => {
    setState({ marquee: [10, 20, 132, 200] });
    const { container } = render(<CanvasStage />);
    const canvas = container.querySelector("canvas.view");
    const marquee = container.querySelector(".marquee");
    expect(canvas).toBeInTheDocument();
    expect(marquee).toBeInTheDocument();
    expect(canvas?.parentElement).toBe(marquee?.parentElement);
    expect(canvas?.parentElement?.className).toBe("stage-inner");
  });
});
