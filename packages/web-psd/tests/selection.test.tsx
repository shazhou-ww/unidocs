import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolStrip } from "../src/ui/panels/tool-strip.js";
import { ContextBar } from "../src/ui/panels/context-bar.js";
import { setState, getState } from "../src/ui/store.js";

const dispatch = vi.fn();
const pickColor = vi.fn(() => "#f5efe3");
vi.mock("../src/ui/controller.js", () => ({
  dispatch: (op: unknown) => dispatch(op),
  getController: () => ({ pickColor, toCanvas: (x: number, y: number) => ({ x, y }) }),
}));

beforeEach(() => {
  dispatch.mockClear();
  setState({ tool: "move", marquee: null, selection: [], pickedColor: null });
});

describe("ToolStrip", () => {
  it("switches the active tool", () => {
    render(<ToolStrip />);
    fireEvent.click(screen.getByText("框选"));
    expect(getState().tool).toBe("marquee");
    fireEvent.click(screen.getByText("取色"));
    expect(getState().tool).toBe("eyedrop");
  });
});

describe("ContextBar", () => {
  it("stays quiet with no marquee", () => {
    render(<ContextBar />);
    expect(screen.queryByText("裁到选区")).not.toBeInTheDocument();
  });

  it("reports the marquee size and crops to it", () => {
    setState({ marquee: [10, 20, 132, 200] });
    render(<ContextBar />);
    expect(screen.getByText("选区 180 × 122")).toBeInTheDocument();
    fireEvent.click(screen.getByText("裁到选区"));
    expect(dispatch).toHaveBeenCalledWith({ kind: "crop", payload: { rect: [10, 20, 132, 200] } });
  });
});
