import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { SelectionBox } from "../src/ui/panels/selection-box.js";
import { setState } from "../src/ui/store.js";
import { setHoverId } from "../src/ui/overlay-store.js";
import type { LocalLayer } from "../src/doc-model.js";

const leaf = (id: string, bounds: [number, number, number, number]): LocalLayer =>
  ({ id, type: "raster", name: id, opacity: 1, blendMode: "normal", visible: true, bounds });

beforeEach(() => {
  setHoverId(null);
  setState({
    selection: [], zoom: 1,
    doc: { canvas: { width: 400, height: 200 }, layers: [
      leaf("a", [20, 40, 120, 240]),
      leaf("b", [0, 0, 40, 80]),
      { id: "g", type: "group", name: "g", opacity: 1, blendMode: "normal", visible: true,
        bounds: [0, 0, 0, 0], children: [leaf("c", [100, 100, 200, 400])] },
    ] },
  });
});

describe("SelectionBox", () => {
  it("draws nothing without a selection", () => {
    const { container } = render(<SelectionBox />);
    expect(container.querySelector(".sel-union")).toBeNull();
  });

  /**
   * Percentages, not pixels — jsdom does no layout, so a measured overlay is
   * untestable here, while the percentages sit in the inline style where they
   * ARE readable. Their independence from zoom is the whole property (see
   * canvas-stage-overlay.test.tsx, which asserts the same thing for .marquee).
   */
  it("positions a single selection as a percentage of the document, unchanged by zoom", () => {
    setState({ selection: ["a"] });
    const { container, rerender } = render(<SelectionBox />);
    const box = () => container.querySelector(".sel-union") as HTMLElement;
    expect(box().style.left).toBe("10%");    // 40/400
    expect(box().style.top).toBe("10%");     // 20/200
    expect(box().style.width).toBe("50%");   // (240-40)/400
    expect(box().style.height).toBe("50%");  // (120-20)/200
    expect(container.querySelectorAll(".sel-union .h")).toHaveLength(8);

    act(() => { setState({ zoom: 4 }); });
    rerender(<SelectionBox />);
    expect(box().style.left).toBe("10%");
    expect(box().style.width).toBe("50%");
  });

  it("draws one thin box per layer plus one union box with the handles when several are selected", () => {
    setState({ selection: ["a", "b"] });
    const { container } = render(<SelectionBox />);
    expect(container.querySelectorAll(".sel-box")).toHaveLength(2);
    const union = container.querySelector(".sel-union") as HTMLElement;
    expect(union.style.left).toBe("0%");     // min(40,0)/400
    expect(union.style.width).toBe("60%");   // (240-0)/400
    expect(container.querySelectorAll(".sel-box .h")).toHaveLength(0);
  });

  // A group's own bounds are 0,0,0,0 in a PSD — the box has to come from the
  // children or it collapses into the corner.
  it("boxes a group by its children", () => {
    setState({ selection: ["g"] });
    const { container } = render(<SelectionBox />);
    const union = container.querySelector(".sel-union") as HTMLElement;
    expect(union.style.left).toBe("25%");    // 100/400
    expect(union.style.height).toBe("50%");  // (200-100)/200
  });

  it("draws a hover outline for a layer that is not selected, and not for one that is", () => {
    const { container, rerender } = render(<SelectionBox />);
    act(() => { setHoverId("b"); });
    rerender(<SelectionBox />);
    expect(container.querySelector(".sel-hover")).not.toBeNull();

    act(() => { setState({ selection: ["b"] }); });
    rerender(<SelectionBox />);
    expect(container.querySelector(".sel-hover")).toBeNull();
  });

  it("draws nothing when no document is open — the empty state is the first screen", () => {
    setState({ selection: ["a"], doc: null });
    const { container } = render(<SelectionBox />);
    expect(container.firstChild).toBeNull();
  });
});
