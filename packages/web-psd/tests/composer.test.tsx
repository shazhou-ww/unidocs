import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/ui/panels/composer.js";
import { setState } from "../src/ui/store.js";
import { rectRegion } from "../src/ui/region.js";
import type { LocalLayer } from "../src/doc-model.js";

const leaf = (id: string, name: string): LocalLayer =>
  ({ id, type: "raster", name, opacity: 1, blendMode: "normal", visible: true });

beforeEach(() => {
  setState({
    region: null, selection: [],
    doc: { canvas: { width: 400, height: 200 }, layers: [leaf("a", "天空")] },
  });
});

const send = (text: string) => {
  fireEvent.change(screen.getByPlaceholderText(/说明要改什么/), { target: { value: text } });
  fireEvent.keyDown(screen.getByPlaceholderText(/说明要改什么/), { key: "Enter" });
};

describe("Composer", () => {
  it("sends no target when there is no region", () => {
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    expect(screen.queryByText(/已附带选区/)).not.toBeInTheDocument();
    send("随便改改");
    expect(onSend).toHaveBeenCalledWith("随便改改", null);
  });

  it("shows a chip and attaches bounds plus selected layer names", () => {
    setState({ region: rectRegion([20, 40, 120, 240]), selection: ["a"] });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    expect(screen.getByText("已附带选区 200 × 100")).toBeInTheDocument();
    send("换成晚霞");
    expect(onSend).toHaveBeenCalledWith("换成晚霞", { bounds: [20, 40, 120, 240], layerNames: ["天空"] });
  });

  // Attaching on every turn is required (by turn three, "a bit more to the
  // left" has to still mean the same patch) — so the user must be able to SEE
  // it and take it off, or state leaves the browser without their knowledge.
  it("stops attaching once the chip is dismissed, without clearing the region", () => {
    setState({ region: rectRegion([20, 40, 120, 240]) });
    const onSend = vi.fn();
    render(<Composer busy={false} onSend={onSend} />);
    fireEvent.click(screen.getByLabelText("不附带选区"));
    expect(screen.queryByText(/已附带选区/)).not.toBeInTheDocument();
    send("换成晚霞");
    expect(onSend).toHaveBeenCalledWith("换成晚霞", null);
  });
});
