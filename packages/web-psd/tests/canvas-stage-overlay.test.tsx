import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
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
  setState({
    tool: "move", marquee: null, selection: [], pickedColor: null, zoom: 1,
    doc: { canvas: { width: 400, height: 200 }, layers: [] } as never,
  });
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

  /**
   * The overlay must position itself as a fraction of the canvas box, not in
   * measured pixels. jsdom does no layout, so a pixel-positioned overlay is
   * untestable here — but percentages live in the inline style, where they
   * ARE readable, and their independence from zoom is the whole property.
   */
  it("positions the marquee as a percentage of the document, unchanged by zoom", () => {
    setState({ marquee: [20, 40, 120, 240] }); // doc is 400x200
    const { container, rerender } = render(<CanvasStage />);
    const marquee = () => container.querySelector(".marquee") as HTMLElement;

    expect(marquee().style.left).toBe("10%");   // 40/400
    expect(marquee().style.top).toBe("10%");    // 20/200
    expect(marquee().style.width).toBe("50%");  // (240-40)/400
    expect(marquee().style.height).toBe("50%"); // (120-20)/200

    // Zooming resizes the canvas box; the overlay's own style must not move,
    // because the browser re-resolves the same percentages against the new
    // box during layout. A version that measured the box during render would
    // have to change these numbers — and would compute them from the box as
    // it was BEFORE the new canvas size was committed.
    act(() => { setState({ zoom: 4 }); });
    rerender(<CanvasStage />);
    expect(marquee().style.left).toBe("10%");
    expect(marquee().style.width).toBe("50%");
  });

  it("renders nothing when there is no document to be a fraction of", () => {
    setState({ marquee: [10, 20, 30, 40], doc: null as never });
    const { container } = render(<CanvasStage />);
    expect(container.querySelector(".marquee")).not.toBeInTheDocument();
  });
});
